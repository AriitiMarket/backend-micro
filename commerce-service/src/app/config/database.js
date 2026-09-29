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
