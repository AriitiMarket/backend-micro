const mongoose = require('mongoose');
const env = require('./env');

// Boot-time migration — the project's migration mechanism (see
// identity-service/src/config/database.js for the SQL equivalent).
//
// Two renames live here, both idempotent and non-destructive:
//
//  1. the ORDER ↔ DELIVERY bridge stored the delivery actor under `partnerId`;
//     Delivery renamed that actor to provider, so the mirror field follows;
//  2. the buy-side owner of an order (and of a request) was `customerId`; the
//     canonical actor name is BUYER, so the field is `buyerId`.
//
// A legacy index drop also lives here: `sellerapplications.ownerId_1` (non-
// unique) is replaced by the unique per-owner index the model declares.
//
// For every rename the `$exists` guards mean a document that already has the
// new field (or never had the old one) is not matched — running this on every
// boot is a no-op the second time and can never overwrite a value written after
// the first run. `FOLDED_FIELDS` handles the documents that carried BOTH names
// (requests were written with a `customerId`/`buyerId` twin): the canonical
// `buyerId` wins and the legacy twin is unset. Nothing is dropped.
const RENAMES = [
  { collection: 'orderdeliveries', from: 'partnerId', to: 'providerId' },
  { collection: 'orders', from: 'customerId', to: 'buyerId' },
  { collection: 'requests', from: 'customerId', to: 'buyerId' },
];

const FOLDED_FIELDS = [
  { collection: 'requests', keep: 'buyerId', drop: 'customerId' },
];

async function runMigrations(db) {
  const changed = [];
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  // Fold first: a document that already has the canonical field must not be
  // touched by the rename below.
  for (const { collection, keep, drop } of FOLDED_FIELDS) {
    if (!existing.has(collection)) continue;
    const result = await db.collection(collection).updateMany(
      { [keep]: { $exists: true }, [drop]: { $exists: true } },
      { $unset: { [drop]: '' } }
    );
    if (result.modifiedCount > 0) {
      changed.push(`${collection}.${drop} folded into ${keep} (${result.modifiedCount} document(s))`);
    }
  }

  for (const { collection, from, to } of RENAMES) {
    if (!existing.has(collection)) continue;
    const result = await db.collection(collection).updateMany(
      { [to]: { $exists: false }, [from]: { $exists: true } },
      { $rename: { [from]: to } }
    );
    if (result.modifiedCount > 0) {
      changed.push(`${collection}.${from} -> ${to} (${result.modifiedCount} document(s))`);
    }
  }

  // Order.status gains a real enum, which is only safe once the legacy
  // spellings are gone: mongoose validates an enum on every `.save()`, so a
  // document still carrying 'PENDING' would start throwing on unrelated writes
  // (a payment flag, an address fix) the moment the model is loaded. Every
  // stored value is therefore rewritten onto its canonical spelling first.
  //
  // `STATUS_ALIASES` is the same table the state machine already uses, so this
  // cannot invent a mapping: a value it does not recognise is left alone (and
  // will still fail validation, loudly, which is the intent).
  if (existing.has('orders')) {
    const { ORDER_STATUSES, STATUS_ALIASES } = require('../../modules/fulfillment/constants/orderStatuses');
    const canonical = new Set(Object.values(ORDER_STATUSES));
    const legacyToCanonical = { ...STATUS_ALIASES };
    // Spellings that normalize() resolves by title-casing rather than by table.
    for (const value of canonical) {
      for (const spelling of [value.toUpperCase().replace(/\s+/g, '_'), value.toUpperCase()]) {
        if (!canonical.has(spelling)) legacyToCanonical[spelling] = value;
      }
    }
    for (const [from, to] of Object.entries(legacyToCanonical)) {
      if (from === to || canonical.has(from)) continue;
      const result = await db.collection('orders').updateMany(
        { status: from },
        { $set: { status: to } }
      );
      if (result.modifiedCount > 0) {
        changed.push(`orders: status ${from} -> ${to} (${result.modifiedCount} document(s))`);
      }
    }
  }

  // The old non-unique ownerId index predates the unique per-owner index the
  // SellerApplication model now declares; drop it so the new one (different
  // options, explicitly named) can be built. Missing index = no-op.
  const SELLER_APPLICATION_COLLECTION = 'sellerapplications';
  if (existing.has(SELLER_APPLICATION_COLLECTION)) {
    const indexes = await db.collection(SELLER_APPLICATION_COLLECTION).indexes();
    if (indexes.some((ix) => ix.name === 'ownerId_1')) {
      await db.collection(SELLER_APPLICATION_COLLECTION).dropIndex('ownerId_1');
      changed.push(`${SELLER_APPLICATION_COLLECTION}: dropped legacy index ownerId_1`);
    }
  }

  return changed;
}

async function connectDatabase() {
  await mongoose.connect(env.mongodbUri);
  console.log(`[commerce] MongoDB connected: ${env.mongodbUri}`);

  const changed = await runMigrations(mongoose.connection.db);
  console.log(changed.length > 0
    ? `[commerce] migration applied: ${changed.join('; ')}`
    : '[commerce] migration: nothing to do (already up to date)');
}

module.exports = { connectDatabase, runMigrations };
