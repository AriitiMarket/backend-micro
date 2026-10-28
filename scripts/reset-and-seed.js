#!/usr/bin/env node
'use strict';
/**
 * Master Reset & Seed Script for Aritii Market
 *
 * Resets and populates the entire platform with authentic, consistent data:
 *   1. Delivery Service:
 *      - Real Ethiopian hierarchy (Country -> Regions -> Cities -> Sub-locations)
 *      - Harar (Jugol, Abadir, Shenkor, Amir Nur, Hakim, Jin'Eala)
 *      - Dire Dawa (Kazira, Sabian, Megala, Kebele 01, Dechatu, Gende Kore)
 *      - Active delivery zones with real coverage geometry and fee schedules
 *      - Distribution ports, delivery services, routes, and providers
 *
 *   2. Identity Service:
 *      - Admin accounts (Super Admin, Operations Admin)
 *      - Seller accounts (Harar & Dire Dawa verified merchants)
 *      - Customer/Buyer accounts with saved addresses in Jugol & Kazira
 *      - Delivery Provider accounts with approved memberships
 *
 *   3. Commerce Service:
 *      - Realistic categories with high-res online image URLs
 *      - Real physical shops in Harar & Dire Dawa with verified location snapshots
 *      - Active delivery coverage mapped to the delivery zones
 *      - Realistic products with direct online CDN images & realistic ETB pricing
 *      - Demo orders validated against location hierarchy and delivery zones
 *
 * Usage:
 *   node scripts/reset-and-seed.js
 */

const { execSync } = require('child_process');
const path = require('path');

function runInDocker(container, command, description) {
  console.log(`\n============================================================`);
  console.log(`▶ ${description} (${container})`);
  console.log(`============================================================`);
  try {
    execSync(`docker exec ${container} ${command}`, { stdio: 'inherit' });
    console.log(`✓ ${description} completed successfully.`);
  } catch (err) {
    console.error(`✗ Error running ${description}:`, err.message);
    throw err;
  }
}

async function main() {
  const startTime = Date.now();
  console.log('\n============================================================');
  console.log('  ARITII MARKET — COMPLETE DATA RESET & SEED');
  console.log('============================================================');

  // Step 1: Seed Delivery Infrastructure
  runInDocker(
    'aritii-delivery',
    'node delivery-service/src/seed/seed.js',
    'Seeding Delivery Locations, Zones, Hubs, and Providers'
  );

  // Step 2: Seed Identity Accounts & Roles
  runInDocker(
    'aritii-identity',
    'node identity-service/src/seed/seed-all.js',
    'Seeding Identity Users (Admins, Sellers, Buyers, Providers)'
  );

  // Step 3: Seed Commerce (Categories, Shops, Products, Orders)
  runInDocker(
    'aritii-commerce',
    'node commerce-service/src/seed/seed-commerce.js --reset',
    'Seeding Commerce (Categories, Shops, Real Products & Validated Orders)'
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n============================================================');
  console.log(`✓ ALL PLATFORM DATA SEEDED SUCCESSFULLY in ${elapsed}s`);
  console.log('============================================================');
  console.log('Test Credentials:');
  console.log('  Super Admin:        admin@aritii.com    / Admin@12345');
  console.log('  Ops Admin:          opsadmin@aritii.com / Admin@12345');
  console.log('  Harar Seller 1:     seller1@aritii.com  / Seller@12345');
  console.log('  Harar Seller 2:     seller2@aritii.com  / Seller@12345');
  console.log('  Dire Dawa Seller 3: seller3@aritii.com  / Seller@12345');
  console.log('  Dire Dawa Seller 4: seller4@aritii.com  / Seller@12345');
  console.log('  Dire Dawa Seller 5: seller5@aritii.com  / Seller@12345');
  console.log('  Harar Buyer:        buyer1@aritii.com   / Buyer@12345');
  console.log('  Dire Dawa Buyer:    buyer2@aritii.com   / Buyer@12345');
  console.log('  Delivery Provider:  provider@aritii.com / Provider@12345');
  console.log('============================================================\n');
}

main().catch((err) => {
  console.error('\nFatal error during reset and seed:', err);
  process.exit(1);
});
