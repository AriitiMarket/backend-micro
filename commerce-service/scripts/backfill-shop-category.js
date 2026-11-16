#!/usr/bin/env node
// Backfill Shop.category for shops approved BEFORE the shop-category field
// existed. Source of truth is the approved SellerApplication:
//   shopInformation.category || businessInformation.businessCategory
//
// Usage:
//   COMPOSE_PROJECT_NAME=aritii-v2 docker compose exec commerce-service \
//     node scripts/backfill-shop-category.js [--dry-run]

const mongoose = require('mongoose');
const Shop = require('../src/modules/selling/models/Shops');
const SellerApplication = require('../src/modules/selling/models/SellerApplications');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ariti_commerce';
const DRY_RUN = process.argv.includes('--dry-run');

async function backfill() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);

    const shops = await Shop.find({
      $or: [{ category: { $exists: false } }, { category: '' }, { category: null }],
    }).lean();

    console.log(`Shops missing a category: ${shops.length}`);

    let updated = 0;
    let unmatched = 0;

    for (const shop of shops) {
      const app = await SellerApplication.findOne({
        $or: [
          ...(shop.applicationId ? [{ _id: shop.applicationId }] : []),
          { ownerId: shop.ownerId },
        ],
      }).sort({ status: 'APPROVED' });

      const category = String(
        (app && (app.shopInformation?.category || app.businessInformation?.businessCategory)) || ''
      ).trim();

      if (!category) {
        unmatched++;
        console.log(`  - "${shop.name}": no application category found (owner ${shop.ownerId})`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  - [DRY RUN] would set "${shop.name}" -> category: "${category}"`);
      } else {
        await Shop.updateOne({ _id: shop._id }, { $set: { category } });
        console.log(`  - updated "${shop.name}" -> category: "${category}"`);
      }
      updated++;
    }

    console.log(`Done. Updated: ${updated}, Unmatched: ${unmatched}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  }
}

backfill();
