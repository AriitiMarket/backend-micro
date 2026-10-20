/**
 * SELLER WALLET INITIALIZATION SCRIPT
 *
 * Run once to create wallets for all existing sellers who don't have one.
 *
 * Usage: node scripts/initializeSellerWallets.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const SellerWallet = require('../src/modules/fulfillment/models/SellerWallet');
const User = require('../src/modules/selling/models/User'); // Adjust if different

async function initializeSellerWallets() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/aritii';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Find all sellers (users with role SELLER)
    const sellers = await User.find({ role: 'SELLER' }).lean();
    console.log(`Found ${sellers.length} sellers`);

    let created = 0;
    let skipped = 0;

    for (const seller of sellers) {
      // Check if wallet already exists
      const existingWallet = await SellerWallet.findOne({ sellerId: seller._id });

      if (existingWallet) {
        console.log(`Wallet already exists for seller ${seller._id} (${seller.email || seller.name})`);
        skipped++;
        continue;
      }

      // Create wallet
      const wallet = await SellerWallet.create({
        sellerId: seller._id,
        currency: 'ETB',
        status: 'ACTIVE',
        availableBalance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalCommissionDeducted: 0,
        totalRefunded: 0,
        totalAdjusted: 0,
        totalPaidOut: 0
      });

      console.log(`Created wallet for seller ${seller._id} (${seller.email || seller.name}) - Wallet ID: ${wallet._id}`);
      created++;
    }

    console.log(`\nInitialization complete:`);
    console.log(`  Wallets created: ${created}`);
    console.log(`  Wallets skipped (already existed): ${skipped}`);
    console.log(`  Total sellers processed: ${sellers.length}`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('Initialization failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

initializeSellerWallets();