#!/usr/bin/env node
// Consolidate legacy duplicate wishlist documents before enabling the unique
// userId index. Dry-run by default; pass --apply to merge and create the index.
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ariti_commerce';
const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const collection = mongoose.connection.db.collection('wishlists');
  const duplicates = await collection.aggregate([
    { $group: { _id: '$userId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  let mergedCount = 0;
  for (const group of duplicates) {
    const docs = await collection.find({ _id: { $in: group.ids } }).sort({ updatedAt: -1, _id: 1 }).toArray();
    const byProduct = new Map();
    for (const doc of docs) {
      for (const item of doc.items || []) {
        const key = String(item.productId || '');
        if (!key) continue;
        const old = byProduct.get(key);
        if (!old || new Date(item.updatedAt || 0) > new Date(old.updatedAt || 0)) byProduct.set(key, item);
      }
    }

    if (APPLY) {
      const [canonical, ...redundant] = docs;
      await collection.updateOne(
        { _id: canonical._id },
        { $set: { items: [...byProduct.values()], updatedAt: new Date() } }
      );
      if (redundant.length) await collection.deleteMany({ _id: { $in: redundant.map((doc) => doc._id) } });
    }
    mergedCount += docs.length - 1;
  }

  if (APPLY) {
    // The legacy indexes are replaced by the single unique userId index the
    // model declares. They must go first: MongoDB refuses to create an index
    // whose name already exists with other options (IndexKeySpecsConflict) and
    // refuses a second index on the same key pattern with other options
    // (IndexOptionsConflict).
    for (const legacy of ['userId_1', 'userId_1_items.productId_1']) {
      try {
        await collection.dropIndex(legacy);
        console.log(`dropped legacy index ${legacy}`);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound' && err.code !== 27) throw err;
      }
    }
    await collection.createIndex({ userId: 1 }, { unique: true, name: 'userId_unique' });
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', duplicateUsers: duplicates.length, duplicateDocumentsToMerge: mergedCount }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
