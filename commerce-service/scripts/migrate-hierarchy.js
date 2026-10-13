#!/usr/bin/env node
/**
 * Hierarchy backfill — User -> Seller Actor -> Business -> Shop -> Products/Orders/Inventory.
 *
 * Fixes the four data-integrity breaks found in the audit:
 *
 *   1. Shop -> Business : `Shop.businessId`/`applicationId` were unset on 11 of
 *      12 shops, and 4 shops had an owner with no business record at all. A
 *      minimal business (flagged `provisionedFromShop`) is created for them.
 *   2. Order -> Business : `sellerShipments[].businessId` held the owner's
 *      Identity *user id* (or nothing), while the admin hierarchy scope reads
 *      it as a SellerApplication _id, so every business-scoped order query
 *      missed. Rewritten to the business id.
 *   3. Product -> Shop   : the denormalised `shop` snapshot on products had
 *      drifted from the live Shop document. Resynchronised.
 *   4. Everything else is REPORTED, never guessed: a business whose status
 *      disagrees with its shops, orders whose shop no longer exists, products
 *      pointing at a deleted shop, stock movements with a dangling product.
 *
 * Deliberately self-contained (raw collections, not the mongoose models) so a
 * migration never depends on the schema strictness of whichever build happens
 * to be running — and so it can be copied into a container as-is.
 *
 * Usage:
 *   node scripts/migrate-hierarchy.js            # DRY RUN — prints the report
 *   node scripts/migrate-hierarchy.js --apply    # write the changes
 *   node scripts/migrate-hierarchy.js --json     # machine-readable report
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ariti_commerce';

const APPLY = process.argv.includes('--apply');
const AS_JSON = process.argv.includes('--json');

const LIVE_SHOP_STATUSES = ['APPROVED', 'ACTIVE'];
const BUSINESS_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'];
const SNAPSHOT_FIELDS = [
  'name', 'avatar', 'email', 'phoneNumber', 'address', 'description',
  'status', 'showOnPublic', 'ownerId',
];

function oid(value) {
  try { return new mongoose.Types.ObjectId(String(value)); } catch { return null; }
}

function sameSnapshotField(a, b) {
  if (a === b) return true;
  // "missing" on either side is not a drift worth rewriting.
  if (a == null && b == null) return true;
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  // A number where the schema (and the live Shop) says string IS drift: the
  // product card would render 55510001 while the shop page renders "55510001".
  if (typeof a !== typeof b) return false;
  return String(a) === String(b);
}

async function main() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const db = mongoose.connection.db;
  const shopsCol = db.collection('shops');
  const appsCol = db.collection('sellerapplications');
  const productsCol = db.collection('products');
  const ordersCol = db.collection('orders');
  const stockCol = db.collection('stockmovements');

  const report = {
    mode: APPLY ? 'apply' : 'dry-run',
    mongoUri: MONGO_URI.replace(/\/\/[^@]*@/, '//***@'),
    summary: {},
    changes: {
      businessesCreated: 0,
      shopsLinked: 0,
      shopFieldsNormalized: 0,
      ordersRelinked: 0,
      productSnapshotsResynced: 0,
      productSnapshotFields: 0,
    },
    details: {
      businessesCreated: [],
      shopsLinked: [],
      shopFieldsNormalized: [],
      ordersRelinked: [],
      productSnapshotsResynced: [],
    },
    anomalies: {
      businessStatusVsShops: [],
      invalidBusinessStatus: [],
      ordersWithMissingShop: [],
      productsWithMissingShop: [],
      stockMovementsWithDanglingRefs: [],
      shopsWithoutOwner: [],
      applicationsWithoutShop: [],
      danglingBusinessRefs: [],
    },
    errors: [],
  };

  const [shops, apps, productCount, orderCount, stockCount] = await Promise.all([
    shopsCol.find({}).toArray(),
    appsCol.find({}).toArray(),
    productsCol.countDocuments(),
    ordersCol.countDocuments(),
    stockCol.countDocuments(),
  ]);

  report.summary = {
    shops: shops.length,
    businesses: apps.length,
    products: productCount,
    orders: orderCount,
    stockMovements: stockCount,
  };

  // ── 0. Shop field types (the schema says String, legacy rows hold numbers) ──
  // Left as a number, `shop.phoneNumber` reads back through the model already
  // cast — but the RAW product snapshot then compares unequal forever. Write
  // the schema's type once so every reader sees the same value.
  const STRING_FIELDS = ['phoneNumber', 'zipCode'];
  for (const shop of shops) {
    const set = {};
    for (const field of STRING_FIELDS) {
      const value = shop[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        set[field] = String(value);
        shop[field] = set[field];
      }
    }
    if (!Object.keys(set).length) continue;
    report.changes.shopFieldsNormalized += 1;
    report.details.shopFieldsNormalized.push({
      shopId: String(shop._id), name: shop.name || null, fields: Object.keys(set),
    });
    if (APPLY) {
      try {
        await shopsCol.updateOne({ _id: shop._id }, { $set: set });
      } catch (e) {
        report.errors.push(`shop ${shop._id}: type normalisation failed (${e.message})`);
      }
    }
  }

  // ── index the businesses ────────────────────────────────────────────────
  const appByOwner = new Map();
  const appById = new Map();
  for (const app of apps) {
    appById.set(String(app._id), app);
    if (app.ownerId) appByOwner.set(String(app.ownerId), app);
  }

  const liveShopIds = new Set(shops.map((s) => String(s._id)));

  // ── 1. Shop -> Business ─────────────────────────────────────────────────
  const businessIdByShop = new Map();

  for (const shop of shops) {
    const shopId = String(shop._id);
    if (!shop.ownerId) {
      report.anomalies.shopsWithoutOwner.push({ shopId, name: shop.name || null });
      continue;
    }

    let businessId = shop.businessId || shop.applicationId || null;

    if (businessId) {
      if (!appById.has(String(businessId))) {
        report.anomalies.danglingBusinessRefs.push({
          shopId, name: shop.name || null, businessId: String(businessId),
        });
        businessId = null;
      }
    }

    if (!businessId) {
      const ownerApp = appByOwner.get(String(shop.ownerId));
      if (ownerApp) {
        businessId = String(ownerApp._id);
      } else {
        // No business at all: synthesise the minimal record so the seller has
        // a business to own this shop with.
        businessId = new mongoose.Types.ObjectId().toHexString();
        const live = LIVE_SHOP_STATUSES.includes(String(shop.status || '').toUpperCase());
        const business = {
          _id: oid(businessId),
          ownerId: String(shop.ownerId),
          userId: String(shop.ownerId),
          sellerType: 'INDIVIDUAL',
          businessInformation: {
            businessName: String(shop.name || '').trim(),
            businessCategory: String(shop.category || '').trim(),
            description: '',
            phone: '',
            email: String(shop.email || '').trim(),
          },
          shopInformation: {
            shopName: String(shop.name || '').trim(),
            publicEmail: String(shop.email || '').trim(),
          },
          status: live ? 'APPROVED' : 'DRAFT',
          ...(live ? { approvedAt: new Date() } : {}),
          provisionedFromShop: true,
          statusTimeline: [{
            status: live ? 'APPROVED' : 'DRAFT',
            changedBy: String(shop.ownerId),
            changedAt: new Date(),
            reason: 'Provisioned from an existing shop',
          }],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        report.changes.businessesCreated += 1;
        report.details.businessesCreated.push({
          businessId,
          ownerId: shop.ownerId,
          businessName: business.businessInformation.businessName,
          status: business.status,
        });

        if (APPLY) {
          try {
            await appsCol.insertOne(business);
            appById.set(businessId, business);
            appByOwner.set(business.ownerId, business);
          } catch (e) {
            // Unique index on ownerId: another shop of the same owner won the
            // race — reuse whichever record landed.
            const winner = await appsCol.findOne({ ownerId: String(shop.ownerId) });
            if (winner) {
              businessId = String(winner._id);
              appById.set(businessId, winner);
              appByOwner.set(winner.ownerId, winner);
            } else {
              report.errors.push(`shop ${shopId}: could not create business (${e.message})`);
              continue;
            }
          }
        } else {
          // Dry run: keep an in-memory record so the same owner does not get
          // counted (and would not be inserted twice) for every shop.
          const ghost = { _id: oid(businessId), ownerId: String(shop.ownerId), status: business.status };
          appById.set(businessId, ghost);
          appByOwner.set(ghost.ownerId, ghost);
        }
      }
    }

    const set = {};
    if (!shop.businessId) set.businessId = businessId;
    if (!shop.applicationId) set.applicationId = businessId;
    if (Object.keys(set).length) {
      report.changes.shopsLinked += 1;
      report.details.shopsLinked.push({
        shopId, name: shop.name || null, businessId, set: Object.keys(set),
      });
      if (APPLY) {
        try {
          await shopsCol.updateOne({ _id: shop._id }, { $set: { ...set, updatedAt: new Date() } });
        } catch (e) {
          report.errors.push(`shop ${shopId}: link failed (${e.message})`);
        }
      }
      shop.businessId = shop.businessId || businessId;
      shop.applicationId = shop.applicationId || businessId;
    }

    businessIdByShop.set(shopId, businessId);

    // Reported, never auto-fixed: a business whose review status disagrees
    // with the shops it owns. Approval of a SHOP is driven by the seller's
    // Identity status, so this needs a human to decide which side is right.
    const business = appById.get(businessId);
    const ownerHasLiveShop = LIVE_SHOP_STATUSES.includes(String(shop.status || '').toUpperCase());
    if (business && ownerHasLiveShop && business.status && business.status !== 'APPROVED') {
      report.anomalies.businessStatusVsShops.push({
        businessId,
        businessStatus: business.status,
        shopId,
        shopName: shop.name || null,
        shopStatus: shop.status || null,
      });
    }
  }

  // ── 2. Order -> Business ────────────────────────────────────────────────
  const orderCursor = ordersCol.find({}, { projection: { sellerShipments: 1, sellerId: 1 } });
  const orderOps = [];
  while (await orderCursor.hasNext()) {
    const order = await orderCursor.next();
    const shipments = Array.isArray(order.sellerShipments) ? order.sellerShipments : [];
    if (!shipments.length) continue;

    let dirty = false;
    for (const shipment of shipments) {
      const shopId = shipment.shopId ? String(shipment.shopId) : '';
      if (!shopId || !liveShopIds.has(shopId)) {
        report.anomalies.ordersWithMissingShop.push({
          orderId: String(order._id), shopId: shopId || null,
        });
        continue;
      }

      const correct = businessIdByShop.get(shopId) || null;
      const current = shipment.businessId ? String(shipment.businessId) : null;
      if (correct && current !== correct) {
        shipment.businessId = correct;
        dirty = true;
        report.changes.ordersRelinked += 1;
        report.details.ordersRelinked.push({
          orderId: String(order._id), shopId, from: current, to: correct,
        });
      }
    }

    if (dirty) {
      if (APPLY) {
        try {
          await ordersCol.updateOne(
            { _id: order._id },
            { $set: { sellerShipments: order.sellerShipments } }
          );
        } catch (e) {
          report.errors.push(`order ${order._id}: relink failed (${e.message})`);
        }
      }
    }
  }

  // ── 3. Product -> Shop snapshot ─────────────────────────────────────────
  const shopById = new Map(shops.map((s) => [String(s._id), s]));
  const productCursor = productsCol.find({}, { projection: { shopId: 1, shop: 1, sellerId: 1 } });
  while (await productCursor.hasNext()) {
    const product = await productCursor.next();
    const shopId = product.shopId ? String(product.shopId) : '';
    const shop = shopById.get(shopId);

    if (!shop) {
      report.anomalies.productsWithMissingShop.push({
        productId: String(product._id), name: product.name || null, shopId: shopId || null,
      });
      continue;
    }

    const snapshot = product.shop && typeof product.shop === 'object' ? product.shop : {};
    const set = {};
    let fields = 0;
    for (const key of SNAPSHOT_FIELDS) {
      // The live Shop is the source of truth; if it simply does not carry the
      // field there is nothing to copy and the snapshot is left alone.
      if (shop[key] === undefined) continue;
      if (!sameSnapshotField(snapshot[key], shop[key])) {
        set[`shop.${key}`] = shop[key];
        fields += 1;
      }
    }

    if (fields) {
      report.changes.productSnapshotsResynced += 1;
      report.changes.productSnapshotFields += fields;
      if (report.details.productSnapshotsResynced.length < 50) {
        report.details.productSnapshotsResynced.push({
          productId: String(product._id), shopId, fields,
        });
      }
      if (APPLY) {
        try {
          await productsCol.updateOne({ _id: product._id }, { $set: set });
        } catch (e) {
          report.errors.push(`product ${product._id}: snapshot resync failed (${e.message})`);
        }
      }
    }
  }

  // ── 4. Dangling references (report only) ────────────────────────────────
  const productIds = new Set(
    (await productsCol.find({}, { projection: { _id: 1 } }).toArray()).map((p) => String(p._id))
  );
  const stockCursor = stockCol.find({}, { projection: { productId: 1, shopId: 1 } });
  while (await stockCursor.hasNext()) {
    const move = await stockCursor.next();
    const bad = [];
    if (!move.productId || !productIds.has(String(move.productId))) bad.push('productId');
    if (!move.shopId || !liveShopIds.has(String(move.shopId))) bad.push('shopId');
    if (bad.length) {
      report.anomalies.stockMovementsWithDanglingRefs.push({
        movementId: String(move._id), missing: bad,
      });
    }
  }

  for (const app of apps) {
    const ownerShops = shops.filter((s) => String(s.ownerId) === String(app.ownerId));
    if (!ownerShops.length && !app.shopId) {
      report.anomalies.applicationsWithoutShop.push({
        businessId: String(app._id),
        businessName: (app.businessInformation && app.businessInformation.businessName) || null,
        status: app.status || null,
      });
    }
    if (!app.status || !BUSINESS_STATUSES.includes(app.status)) {
      report.anomalies.invalidBusinessStatus.push({
        businessId: String(app._id), businessStatus: app.status || null,
      });
    }
  }

  await mongoose.disconnect();

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  if (report.errors.length) process.exitCode = 1;
}

function printHuman(r) {
  const line = (s = '') => console.log(s);
  line(`\nHierarchy migration — mode: ${r.mode.toUpperCase()}`);
  line(`  ${r.mongoUri}`);
  line('\nInventory');
  line(`  shops=${r.summary.shops}  businesses=${r.summary.businesses}  products=${r.summary.products}  orders=${r.summary.orders}  stockMovements=${r.summary.stockMovements}`);

  line(`\nPlanned changes${r.mode === 'dry-run' ? ' (dry run — nothing was written)' : ''}`);
  line(`  businesses created      : ${r.changes.businessesCreated}`);
  line(`  shops linked to business: ${r.changes.shopsLinked}`);
  line(`  shop fields normalised  : ${r.changes.shopFieldsNormalized}`);
  line(`  orders relinked         : ${r.changes.ordersRelinked}`);
  line(`  product snapshots fixed : ${r.changes.productSnapshotsResynced} (${r.changes.productSnapshotFields} fields)`);

  const section = (title, rows, render) => {
    if (!rows.length) return;
    line(`\n${title} (${rows.length})`);
    rows.slice(0, 25).forEach((row) => line(`  - ${render(row)}`));
    if (rows.length > 25) line(`  … and ${rows.length - 25} more`);
  };

  section('Business status disagrees with its shops (needs a human)', r.anomalies.businessStatusVsShops,
    (x) => `business ${x.businessId} is ${x.businessStatus} while shop ${x.shopId} (${x.shopName}) is ${x.shopStatus}`);
  section('Orders whose shop no longer exists', r.anomalies.ordersWithMissingShop,
    (x) => `order ${x.orderId} -> shop ${x.shopId}`);
  section('Products whose shop no longer exists', r.anomalies.productsWithMissingShop,
    (x) => `product ${x.productId} (${x.name}) -> shop ${x.shopId}`);
  section('Stock movements with dangling references', r.anomalies.stockMovementsWithDanglingRefs,
    (x) => `movement ${x.movementId} missing ${x.missing.join('+')}`);
  section('Shops with no owner', r.anomalies.shopsWithoutOwner,
    (x) => `shop ${x.shopId} (${x.name})`);
  section('Businesses with no shop (application filed, shop not created yet)', r.anomalies.applicationsWithoutShop,
    (x) => `business ${x.businessId} (${x.businessName}) status=${x.status}`);
  section('Businesses with an unknown status', r.anomalies.invalidBusinessStatus,
    (x) => `business ${x.businessId} status=${x.businessStatus}`);
  section('Shops pointing at a business that does not exist', r.anomalies.danglingBusinessRefs,
    (x) => `shop ${x.shopId} (${x.name}) -> ${x.businessId}`);
  section('Errors', r.errors, (x) => x);

  line(r.mode === 'dry-run'
    ? '\nRe-run with --apply to write these changes.'
    : '\nDone. Re-run without --apply to confirm the store is clean.');
  line('');
}

main().catch((err) => {
  console.error('[migrate-hierarchy] failed:', err);
  process.exit(1);
});
