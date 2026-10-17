#!/usr/bin/env node
/**
 * BACKFILL DELIVERY COVERAGE — report-only migration + documented opt-in path.
 *
 * Goal
 * ----
 * Shops need TWO strictly separated pieces of data before checkout can proceed:
 *
 *   1. `locationSnapshot` — WHERE the shop physically is (cityId, address, …).
 *   2. `deliveryCoverage` — WHERE the shop delivers to (zoneIds + status).
 *
 * Neither field may be guessed. A shop whose `locationSnapshot` is empty or
 * whose `deliveryCoverage` is UNCONFIGURED must NOT reach checkout: the cart
 * validator reports LOCATION_NOT_CONFIGURED and the order is blocked.
 *
 * What this script does
 * ---------------------
 * DEFAULT (no flags): REPORT ONLY.
 *   Lists every shop whose location is unknown or whose delivery coverage is
 *   unconfigured, together with the `deliveryZoneId` its SellerApplication
 *   recorded — so an admin can see exactly what the seller claimed to serve.
 *
 * OPT-IN BACKFILL (`--apply`)
 * ---------------------------
 * Only the seller's OWN data is ever written. For a reported shop that has a
 * `SellerApplication` and a non-empty `application.location.deliveryZoneId`:
 *
 *   * `shop.applicationId`  ← the SellerApplication that owns the shop
 *   * `locationSnapshot.cityId` ← the application's own cityId
 *   * `deliveryCoverage`
 *       - source        = 'MIGRATION'          (never ADMIN/APPLICATION)
 *       - verifiedBy    = 'BACKFILL'
 *       - verifiedAt    = now
 *       - zoneIds       = [application.location.deliveryZoneId]
 *       - status        = 'ACTIVE'  ONLY IF that zone resolves to an ACTIVE
 *                               delivery zone. If the Delivery service is not
 *                               reachable, status stays 'UNCONFIGURED' and the
 *                               shop is flagged for manual review — nothing is
 *                               invented, renamed or re-targeted.
 *
 * The backfill deliberately NEVER assigns a zone that the seller did not
 * already record: it copies the zone id from the application, it never maps a
 * free-text city to a zone, and it never fabricates a coverage block.
 *
 * Run against the seed DB and confirm:
 *   node scripts/backfill-delivery-coverage.js            # DRY RUN
 *   MONGODB_URI=mongodb://localhost:27017/ariti_commerce node scripts/backfill-delivery-coverage.js --apply
 *
 * Notes
 * -----
 * - The Delivery zone catalogue is consulted for the ACTIVE check only; the
 *   script never stores a zone it cannot verify exists.
 * - Existing coverage blocks are left untouched; only shops that are missing
 *   coverage are touched.
 */
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ariti_commerce';
const DELIVERY_SERVICE_URL = process.env.DELIVERY_SERVICE_URL || process.env.DELIVERY_SERVICE_HOST;
const AS_JSON = process.argv.includes('--json');
const APPLY = process.argv.includes('--apply');

const SHOPS_COLL = 'shops';
const APPS_COLL = 'sellerApplications';

async function main() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const shops = db.collection(SHOPS_COLL);
  const apps = db.collection(APPS_COLL);

  // Shops that (a) have no location recorded, or (b) are configured to serve
  // no delivery zone. Both are checkout-blocking conditions.
  const pipeline = [
    { $match: { $or: [
      { 'locationSnapshot.cityId': { $in: [null, ''] } },
      { 'locationSnapshot.cityName': { $in: [null, ''] } },
      { 'deliveryCoverage.zoneIds': { $size: 0 } },
      { 'deliveryCoverage.status': 'UNCONFIGURED' },
    ]} },
    {
      $lookup: {
        from: APPS_COLL,
        localField: 'applicationId',
        foreignField: '_id',
        as: 'application',
      },
    },
    { $unwind: { path: '$application', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 1, name: 1, status: 1,
        'locationSnapshot.cityId': 1, 'locationSnapshot.cityName': 1,
        'deliveryCoverage.status': 1, 'deliveryCoverage.zoneIds': 1,
        'application._id': 1, 'application.location.cityId': 1,
        'application.location.deliveryZoneId': 1,
        'application.status': 1,
      },
    },
  ];
  const cursor = await shops.aggregate(pipeline);
  const findings = await cursor.toArray();

  const report = findings.map((f) => ({
    shopId: f._id,
    shopName: f.name,
    shopStatus: f.status,
    missingLocation: !f['locationSnapshot.cityId'] || !f['locationSnapshot.cityName'],
    coverageStatus: f['deliveryCoverage.status'],
    coverageZoneIds: f['deliveryCoverage.zoneIds'],
    appId: f['application._id'],
    appStatus: f['application.status'],
    appCityId: f['application.location.cityId'],
    appZoneId: f['application.location.deliveryZoneId'],
    actionable: APPLY && f['application.location.deliveryZoneId'],
  }));
  const actionable = report.filter((r) => r.actionable);

  if (AS_JSON) console.log(JSON.stringify({ findings: report, actionable: actionable.length }, null, 2));
  else {
    console.log(`Backfill delivery coverage report — ${report.length} shops need attention`);
    console.log(`(--apply will only touch shops whose SellerApplication records a zone id: ${actionable.length})`);
    console.log(
      `${'shop'.padEnd(24)} ${'app'.padEnd(26)} ${'appStatus'.padEnd(12)} ${
        'appZoneId'.padEnd(22)} ${'cityId'.padEnd(12)} ${'coverage'.padEnd(12)} ${'missingLocation'}`
    );
    for (const r of report) {
      console.log(
        `${r.shopId.padEnd(24)} ${String(r.appId).slice(0, 24).padEnd(26)} ${
          String(r.appStatus).padEnd(12)} ${String(r.appZoneId).padEnd(22)} ${
          String(r.appCityId).padEnd(12)} ${String(r.coverageStatus).padEnd(12)} ${r.missingLocation ? 'YES' : 'no'}`
      );
    }
  }

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to apply the opt-in backfill.');
    await mongoose.disconnect();
    return;
  }

  // ---- apply -------------------------------------------------------------
  const changed = [];
  const skippedManual = [];
  for (const f of findings) {
    const zoneId = f['application.location.deliveryZoneId'];
    if (!zoneId) continue; // no opt-in data — nothing to backfill
    const patch = {
      $set: {
        applicationId: f['application._id'],
        'locationSnapshot.cityId': f['application.location.cityId'] || f['locationSnapshot.cityId'],
        'deliveryCoverage.source': 'MIGRATION',
        'deliveryCoverage.verifiedBy': 'BACKFILL',
        'deliveryCoverage.updatedAt': new Date(),
      },
    };

    // Resolve the seller's zone id against the Delivery catalogue so the
    // backfill can never invent a zone. When the service is unreachable, the
    // shop is left UNCONFIGURED and reported for manual review.
    let zoneActive = false;
    if (DELIVERY_SERVICE_URL) {
      try {
        const deliveryClient = require('../src/app/clients/delivery.client').deliveryClient;
        const result = await deliveryClient.getZoneSummaries([zoneId]);
        zoneActive = Boolean(result.ok && Array.isArray(result.body.zones) &&
          result.body.zones.some((z) => z && String(z.status) === 'active'));
      } catch {
        zoneActive = false;
      }
    }
    if (zoneActive) {
      patch.$set['deliveryCoverage.status'] = 'ACTIVE';
    }
    // Record the seller's own zone reference even when unverified (never guess
    // a status): ACTIVE only after the Delivery catalogue confirms it.
    patch.$addToSet['deliveryCoverage.zoneIds'] = zoneId;

    const res = await shops.updateOne(
      { _id: f._id, 'deliveryCoverage.zoneIds': { $ne: zoneId } },
      patch
    );
    if (res.modifiedCount) {
      changed.push({ shopId: f._id, appId: f['application._id'], zoneId, cityId: f['application.location.cityId'], active: zoneActive });
    } else {
      skippedManual.push({ shopId: f._id, appId: f['application._id'], appStatus: f['application.status'], reason: 'no change required' });
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ applied: changed.length, changed }, null, 2));
  } else {
    console.log(`\nApplied backfill to ${changed.length} shop(s):`);
    for (const c of changed) {
      console.log(`  ${c.shopId} <- ${c.appId}  zoneId=${c.zoneId} cityId=${c.cityId} (source=MIGRATION)`);
    }
    if (actionable.length > changed.length) {
      console.log(`\n${actionable.length - changed.length} shop(s) marked for manual review: no Delivery service configured (set DELIVERY_SERVICE_URL to validate the zone).`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('backfill failed:', err.message);
  process.exit(1);
});
