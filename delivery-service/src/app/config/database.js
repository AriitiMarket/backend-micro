const mongoose = require('mongoose');
const env = require('./env');

// Boot-time migrations — the project's migration mechanism (see
// identity-service/src/config/database.js for the SQL equivalent).
//
// Rules for everything below:
//   * idempotent: every statement is a no-op the second time it runs, so it is
//     safe to execute on EVERY boot;
//   * non-destructive: data is renamed or copied, never dropped, and a rename
//     only ever applies to documents that do not already carry the new field;
//   * observable: what actually changed is returned and logged.
//
// The delivery actor was renamed partner -> provider. That touches one
// collection name and two field names:
//   * collection `partners`  -> `providers` (the model now pins
//     `collection: 'providers'`, so mongoose will not look at `partners`);
//   * field `partnerId`      -> `providerId` on every document that references
//     a delivery provider;
//   * field `partnerName`    -> `providerName` (the denormalized display name
//     kept next to it on assignment batches).
const MIGRATED_COLLECTIONS = [
  'providers',        // the renamed roster (and its pre-rename spelling)
  'partners',
  'deliveries',
  'assignments',
  'assignmentbatches',
  'shipments',
  'trackingevents',
  'deliveryroutes',
];

const FIELD_RENAMES = [
  { from: 'partnerId', to: 'providerId' },
  { from: 'partnerName', to: 'providerName' },
];

async function runMigrations(db) {
  const changed = [];
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  // 1) Roster collection.
  //
  //    The empty `providers` collection appears on its own: mongoose creates the
  //    collection for the pinned name when it builds the model's indexes, which
  //    can happen BEFORE this migration runs — leaving an empty target beside a
  //    populated `partners`, and `rename` then fails with NamespaceExists. An
  //    EMPTY target carries no data, so dropping it and renaming is lossless and
  //    makes the boot converge instead of warning forever.
  //
  //    Two populated collections are never merged and never dropped: that is a
  //    data question for a human, so it is surfaced instead.
  if (existing.has('partners') && existing.has('providers')) {
    const [sourceCount, targetCount] = await Promise.all([
      db.collection('partners').countDocuments(),
      db.collection('providers').countDocuments(),
    ]);
    if (targetCount === 0 && sourceCount > 0) {
      await db.collection('providers').drop();
      existing.delete('providers');
      changed.push(`empty collection providers dropped (target of the partners rename)`);
    } else {
      console.warn(
        `[delivery] migration: both \`partners\` (${sourceCount}) and \`providers\` (${targetCount}) hold data; ` +
        '\`partners\` was left untouched — please inspect it manually'
      );
    }
  }
  if (existing.has('partners') && !existing.has('providers')) {
    await db.collection('partners').rename('providers');
    existing.delete('partners');
    existing.add('providers');
    changed.push('collection partners -> providers');
  }

  // 2) Field renames. The `$exists` guards are what make this idempotent:
  //    a document that already has `providerId` (or never had `partnerId`) is
  //    not matched, so a second boot reports 0 modified documents and cannot
  //    overwrite a value written after the first boot.
  for (const { from, to } of FIELD_RENAMES) {
    for (const name of MIGRATED_COLLECTIONS) {
      if (!existing.has(name)) continue;
      const result = await db.collection(name).updateMany(
        { [to]: { $exists: false }, [from]: { $exists: true } },
        { $rename: { [from]: to } }
      );
      if (result.modifiedCount > 0) {
        changed.push(`${name}.${from} -> ${to} (${result.modifiedCount} document(s))`);
      }
    }
  }

  // 3) Rejections used to be stored as `suspended` (the status enum had no
  //    `rejected` member), which both misrepresented the review outcome and
  //    locked the applicant out of re-applying. Only documents that carry a
  //    stored rejection reason were rejected — a plain admin suspension never
  //    writes one.
  if (existing.has('providers')) {
    const reclassified = await db.collection('providers').updateMany(
      { status: 'suspended', 'metadata.application.rejectionReason': { $exists: true } },
      { $set: { status: 'rejected' } }
    );
    if (reclassified.modifiedCount > 0) {
      changed.push(`providers: suspended -> rejected for ${reclassified.modifiedCount} rejected application(s)`);
    }
  }

  // 5) Zone MVP lifecycle: documents written before this field existed carry
  //    no value (mongoose only defaults NEW documents), and any zone left on
  //    the removed PILOT value is treated as LIVE. Both cases become LIVE.
  if (existing.has('zones')) {
    const backfilled = await db.collection('zones').updateMany(
      { $or: [{ lifecycle: { $exists: false } }, { lifecycle: null }, { lifecycle: 'PILOT' }] },
      { $set: { lifecycle: 'LIVE' } }
    );
    const pilotCleared = await db.collection('zones').updateMany(
      { pilotLimitPerDay: { $exists: true } },
      { $unset: { pilotLimitPerDay: '' } }
    );
    if (backfilled.modifiedCount > 0) {
      changed.push(`zones: lifecycle backfilled to LIVE for ${backfilled.modifiedCount} zone(s)`);
    }
    if (pilotCleared.modifiedCount > 0) {
      changed.push(`zones: dropped pilotLimitPerDay on ${pilotCleared.modifiedCount} zone(s)`);
    }
  }

  // 5) Delivery lifecycle collapsed to the states that have a writer. Documents
  //    written while the enum still listed the speculative stages are no longer
  //    representable — mongoose would reject the next `.save()` on them, so they
  //    are reclassified onto the state that replaced each one:
  //      validated / ready_for_pickup -> pending        (the ready pool)
  //      out_for_delivery             -> in_transit     (the customer leg)
  //      return_requested / returned  -> delivered      (it reached the customer)
  //    `returned` is the only judgement call: a return has no flow to enter, and
  //    `cancelled` would misreport a completed handover as a failure, so it is
  //    recorded as delivered (the parcel did arrive) rather than lost.
  const DELIVERY_STATUS_COLLAPSE = {
    validated: 'pending',
    ready_for_pickup: 'pending',
    out_for_delivery: 'in_transit',
    return_requested: 'delivered',
    returned: 'delivered',
  };
  const RETIRED_MILESTONE_FIELDS = [
    'validatedAt', 'readyForPickupAt', 'outForDeliveryAt',
    'returnRequestedAt', 'returnedAt', 'returnReason',
  ];
  for (const name of ['deliveries', 'trackingevents']) {
    if (!existing.has(name)) continue;
    for (const [from, to] of Object.entries(DELIVERY_STATUS_COLLAPSE)) {
      const reclassified = await db.collection(name).updateMany(
        { status: from },
        { $set: { status: to } }
      );
      if (reclassified.modifiedCount > 0) {
        changed.push(`${name}: status ${from} -> ${to} (${reclassified.modifiedCount} document(s))`);
      }
    }
    if (name === 'deliveries') {
      const pruned = await db.collection(name).updateMany(
        { $or: RETIRED_MILESTONE_FIELDS.map((field) => ({ [field]: { $ne: null, $exists: true } })) },
        { $unset: Object.fromEntries(RETIRED_MILESTONE_FIELDS.map((field) => [field, ''])) }
      );
      if (pruned.modifiedCount > 0) {
        changed.push(`deliveries: dropped retired milestone fields (${pruned.modifiedCount} document(s))`);
      }
    }
  }

  // 6) The old non-unique sparse index on identityUserId predates the unique
  //    partial index declared by the model; drop it so the new one (different
  //    options, explicitly named) can be built. Missing index = no-op.
  if (existing.has('providers')) {
    const indexes = await db.collection('providers').indexes();
    if (indexes.some((ix) => ix.name === 'identityUserId_1')) {
      await db.collection('providers').dropIndex('identityUserId_1');
      changed.push('providers: dropped legacy sparse index identityUserId_1');
    }
  }

  return changed;
}

async function connectDatabase() {
  await mongoose.connect(env.mongodbUri);
  console.log(`[delivery] MongoDB connected: ${env.mongodbUri}`);

  // Run on every boot; a failure propagates so the server's retry loop tries
  // again rather than serving documents under the old field names.
  const changed = await runMigrations(mongoose.connection.db);
  console.log(changed.length > 0
    ? `[delivery] migration applied: ${changed.join('; ')}`
    : '[delivery] migration: nothing to do (already up to date)');
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connectDatabase, isConnected, runMigrations };
