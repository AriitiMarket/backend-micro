#!/usr/bin/env node
// Comprehensive seed script — Admin, Sellers, Categories, Shops
// Usage:
//   COMPOSE_PROJECT_NAME=aritii-v2 docker compose exec identity-service node src/seed/seed-all.js
//
// Creates:
//   - Admin user: admin@aritii.com / Admin@12345
//   - 3 Seller users with approved shops
//   - 12 Categories (6 product + 6 business)
//   - 3 Shops linked to sellers

const { getPool } = require('../config/database');
const { hashPassword } = require('../utils/password');
const crypto = require('crypto');

// ─── Credentials ──────────────────────────────────────────────────────────────
const ADMIN = { name: 'Aritii Admin', email: 'admin@aritii.com', password: 'Admin@12345' };

const SELLERS = [
  { name: 'TechHub Seller', email: 'seller1@aritii.com', password: 'Seller@12345' },
  { name: 'Fashion Hub Seller', email: 'seller2@aritii.com', password: 'Seller@12345' },
  { name: 'Fresh Market Seller', email: 'seller3@aritii.com', password: 'Seller@12345' },
];

const CATEGORIES = [
  // Product categories
  { title: 'Electronics', description: 'Electronic devices, gadgets, and accessories', type: 'product', sortOrder: 1 },
  { title: 'Fashion', description: 'Clothing, shoes, and fashion accessories', type: 'product', sortOrder: 2 },
  { title: 'Home & Living', description: 'Furniture, decor, and household items', type: 'product', sortOrder: 3 },
  { title: 'Beauty & Personal Care', description: 'Cosmetics, skincare, and personal care products', type: 'product', sortOrder: 4 },
  { title: 'Groceries & Food', description: 'Food, beverages, and grocery items', type: 'product', sortOrder: 5 },
  { title: 'Handcrafts & Local Products', description: 'Handmade and locally sourced products', type: 'product', sortOrder: 6 },
  // Business categories
  { title: 'Retail', description: 'General retail and reselling businesses', type: 'business', sortOrder: 7 },
  { title: 'Food & Beverage', description: 'Restaurants, cafes, and food services', type: 'business', sortOrder: 8 },
  { title: 'Services', description: 'Professional and personal services', type: 'business', sortOrder: 9 },
  { title: 'Manufacturing', description: 'Production and assembly businesses', type: 'business', sortOrder: 10 },
  { title: 'Agriculture', description: 'Farming and agricultural products', type: 'business', sortOrder: 11 },
  { title: 'Technology', description: 'Software, IT, and tech services', type: 'business', sortOrder: 12 },
];

const SHOPS = [
  { name: 'TechHub Electronics', email: 'shop1@aritii.com', description: 'Latest gadgets and electronics at competitive prices', address: '100 Tech Street, Addis Ababa', phone: 55510001, zip: 10001, category: 'Retail' },
  { name: 'Fashion Forward', email: 'shop2@aritii.com', description: 'Trendy clothing and fashion accessories', address: '200 Fashion Ave, Addis Ababa', phone: 55510002, zip: 10002, category: 'Retail' },
  { name: 'Harar Fresh Market', email: 'shop3@aritii.com', description: 'Fresh produce and organic food products', address: '300 Market Road, Harar', phone: 55510003, zip: 10003, category: 'Food & Beverage' },
];

async function seed() {
  const pool = await getPool();
  const results = { admin: null, sellers: [], categories: [], shops: [] };

  // ─── 1. Seed Admin ──────────────────────────────────────────────────────────
  console.log('\n── Seeding Admin ──');
  const existingAdmin = await pool.query('SELECT id, role FROM users WHERE email = $1;', [ADMIN.email]);
  if (existingAdmin.rows.length > 0) {
    const row = existingAdmin.rows[0];
    if (row.role !== 'ADMIN') {
      await pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2;', ['ADMIN', row.id]);
      console.log(`  ✓ User ${ADMIN.email} upgraded to ADMIN`);
    } else {
      console.log(`  ✓ Admin ${ADMIN.email} already exists (id: ${row.id})`);
    }
    results.admin = { id: row.id, email: ADMIN.email };
  } else {
    const id = crypto.randomUUID();
    const hash = await hashPassword(ADMIN.password);
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, status, is_verified, admin_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [id, ADMIN.name, ADMIN.email, hash, 'ADMIN', 'active', true, JSON.stringify({ locations: ['*'], services: ['*'] })]
    );
    console.log(`  ✓ Admin created: ${ADMIN.email} / ${ADMIN.password}`);
    results.admin = { id, email: ADMIN.email };
  }

  // ─── 2. Seed Sellers ────────────────────────────────────────────────────────
  console.log('\n── Seeding Sellers ──');
  for (const seller of SELLERS) {
    const existing = await pool.query('SELECT id, role FROM users WHERE email = $1;', [seller.email]);
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.role !== 'SELLER') {
        await pool.query('UPDATE users SET role = $1, seller_status = $2, updated_at = NOW() WHERE id = $3;', ['SELLER', 'ACTIVE', row.id]);
        console.log(`  ✓ User ${seller.email} upgraded to SELLER`);
      } else {
        console.log(`  ✓ Seller ${seller.email} already exists (id: ${row.id})`);
      }
      results.sellers.push({ id: row.id, email: seller.email, name: seller.name });
    } else {
      const id = crypto.randomUUID();
      const hash = await hashPassword(seller.password);
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, role, status, is_verified, seller_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [id, seller.name, seller.email, hash, 'SELLER', 'active', true, 'ACTIVE']
      );
      console.log(`  ✓ Seller created: ${seller.email} / ${seller.password}`);
      results.sellers.push({ id, email: seller.email, name: seller.name });
    }
  }

  // ─── 3. Seed Categories ─────────────────────────────────────────────────────
  // Categories are stored in MongoDB (commerce-service), so we output the data
  // for the companion commerce seed to pick up.
  console.log('\n── Categories (for commerce-service) ──');
  for (const cat of CATEGORIES) {
    const slug = cat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    console.log(`  → ${cat.title} (${cat.type}) slug=${slug}`);
    results.categories.push({ ...cat, slug });
  }

  // ─── 4. Seed Shops ──────────────────────────────────────────────────────────
  console.log('\n── Shops (for commerce-service) ──');
  for (let i = 0; i < SHOPS.length; i++) {
    const shop = SHOPS[i];
    const seller = results.sellers[i];
    if (seller) {
      console.log(`  → ${shop.name} (owner: ${seller.email})`);
      results.shops.push({ ...shop, sellerId: seller.id });
    }
  }

  // ─── 5. Update seller shop_ids ──────────────────────────────────────────────
  console.log('\n── Linking sellers to shops ──');
  for (let i = 0; i < SHOPS.length && i < results.sellers.length; i++) {
    const seller = results.sellers[i];
    const shop = SHOPS[i];
    // We set a placeholder shop_id; the real MongoDB _id will be set by commerce-service
    // For now we use the shop name as a reference
    await pool.query(
      'UPDATE users SET shop_id = $1, updated_at = NOW() WHERE id = $2;',
      [shop.name, seller.id]
    );
    console.log(`  ✓ ${seller.email} linked to ${shop.name}`);
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('SEED COMPLETE');
  console.log('='.repeat(60));
  console.log('\nLogin Credentials:');
  console.log(`  Admin:   ${ADMIN.email} / ${ADMIN.password}`);
  console.log('  Sellers:');
  for (const s of SELLERS) {
    console.log(`    ${s.email} / ${s.password}`);
  }
  console.log('\nCategories and shops must be seeded via commerce-service.');
  console.log('Run: COMPOSE_PROJECT_NAME=aritii-v2 docker compose exec commerce-service node src/seed/seed-commerce.js');
  console.log('='.repeat(60));

  return results;
}

seed().then(() => process.exit(0)).catch((err) => { console.error('Seed failed:', err); process.exit(1); });
