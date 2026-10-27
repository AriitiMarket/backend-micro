#!/usr/bin/env node
// Comprehensive seed script for Identity Service — Admin, Sellers, Buyers, Providers
// Usage:
//   docker exec -w /app/identity-service aritii-identity node src/seed/seed-all.js [--reset]

const { getPool } = require('../config/database');
const { hashPassword } = require('../utils/password');
const crypto = require('crypto');

// ─── Users to Seed ────────────────────────────────────────────────────────────

const ADMINS = [
  { name: 'Aritii Super Admin', email: 'admin@aritii.com', password: 'Admin@12345', role: 'ADMIN', isSuper: true },
  { name: 'Operations Administrator', email: 'opsadmin@aritii.com', password: 'Admin@12345', role: 'ADMIN', isSuper: false },
];

const SELLERS = [
  { name: 'Harar Coffee Roastery & Spices', email: 'seller1@aritii.com', password: 'Seller@12345', phone: '+251911330001' },
  { name: 'Harar Heritage Crafts & Mesob', email: 'seller2@aritii.com', password: 'Seller@12345', phone: '+251911330002' },
  { name: 'Dire Dawa Oasis Farm Fresh', email: 'seller3@aritii.com', password: 'Seller@12345', phone: '+251911330003' },
  { name: 'Dire Dawa Smart Tech Electronics', email: 'seller4@aritii.com', password: 'Seller@12345', phone: '+251911330004' },
  { name: 'Sabian Modern & Cultural Fashion', email: 'seller5@aritii.com', password: 'Seller@12345', phone: '+251911330005' },
  { name: 'Ras Makonnen Traditional Leatherworks', email: 'seller6@aritii.com', password: 'Seller@12345', phone: '+251911330006' },
  { name: 'Awash Valley Spices & Grain Trading', email: 'seller7@aritii.com', password: 'Seller@12345', phone: '+251911330007' },
  { name: 'Abadir Heritage Silver & Jewelry', email: 'seller8@aritii.com', password: 'Seller@12345', phone: '+251911330008' },
  { name: 'Sheger Home Living & Artisanal Decor', email: 'seller9@aritii.com', password: 'Seller@12345', phone: '+251911330009' },
  { name: 'Highland Pure Organics & Herbal Care', email: 'seller10@aritii.com', password: 'Seller@12345', phone: '+251911330010' },
  { name: 'Aritii Verified Seller', email: 'seller@aritii.com', password: 'Seller@12345', phone: '+251911330011' },
];

const BUYERS = [
  {
    name: 'Amina Kedir',
    email: 'buyer1@aritii.com',
    password: 'Buyer@12345',
    phone: '+251911440001',
    addresses: [
      {
        id: 'addr-harar-1',
        name: 'Amina Kedir',
        phone: '+251911440001',
        addressType: 'Home',
        country: 'Ethiopia',
        region: 'Hararghe',
        city: 'Harar',
        area: 'Jugol',
        address1: 'Near Jugol Gate, House 42',
        isDefault: true,
      },
    ],
  },
  {
    name: 'Dawit Alemu',
    email: 'buyer2@aritii.com',
    password: 'Buyer@12345',
    phone: '+251911440002',
    addresses: [
      {
        id: 'addr-dd-1',
        name: 'Dawit Alemu',
        phone: '+251911440002',
        addressType: 'Home',
        country: 'Ethiopia',
        region: 'Dire Dawa',
        city: 'Dire Dawa City',
        area: 'Kazira',
        address1: 'Kazira Commercial Street, Building 15',
        isDefault: true,
      },
    ],
  },
];

const PROVIDERS = [
  { name: 'Aritii Delivery Provider', email: 'provider@aritii.com', password: 'Provider@12345', phone: '+251911000001' },
  { name: 'Ahmed Ali', email: 'ahmed@aritii.et', password: 'Provider@12345', phone: '+251911111111' },
  { name: 'Fatima Hassan', email: 'fatima@aritii.et', password: 'Provider@12345', phone: '+251922222222' },
  { name: 'Omar Ibrahim', email: 'omar@aritii.et', password: 'Provider@12345', phone: '+251933333333' },
  { name: 'Bekele Tadesse', email: 'bekele@aritii.et', password: 'Provider@12345', phone: '+251944444444' },
  { name: 'Samira Mohammed', email: 'samira@aritii.et', password: 'Provider@12345', phone: '+251955555555' },
];

async function ensureSuperAdminRoleAssignment(pool, userId) {
  const role = await pool.query('SELECT id FROM admin_roles WHERE name = $1;', ['SUPER_ADMIN']);
  if (!role.rows[0]) return;
  await pool.query(
    `INSERT INTO admin_user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) DO NOTHING;`,
    [userId, role.rows[0].id]
  );
}

async function upsertUser(pool, { name, email, password, phone, role, sellerStatus = 'INACTIVE', addresses = [], adminScope = {} }) {
  const hash = await hashPassword(password);
  const existing = await pool.query('SELECT id, role FROM users WHERE email = $1;', [email]);

  let userId;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
    await pool.query(
      `UPDATE users
       SET name = $1, password_hash = $2, phone_number = $3, role = $4,
           active_role = NULL,
           status = 'active', is_verified = true, seller_status = $5,
           addresses = $6::jsonb, admin_scope = $7::jsonb,
           two_factor_enabled = false, two_factor_type = NULL, two_factor_destination = NULL,
           updated_at = NOW()
       WHERE id = $8;`,
      [name, hash, phone, role, sellerStatus, JSON.stringify(addresses), JSON.stringify(adminScope), userId]
    );
    console.log(`  ✓ Updated user ${email} (${role})`);
  } else {
    userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, phone_number, role, status, is_verified, seller_status, addresses, admin_scope)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', true, $7, $8::jsonb, $9::jsonb);`,
      [userId, name, email, hash, phone, role, sellerStatus, JSON.stringify(addresses), JSON.stringify(adminScope)]
    );
    console.log(`  + Created user ${email} (${role})`);
  }

  // Ensure role membership in user_roles
  if (role === 'SELLER' || role === 'PROVIDER') {
    await pool.query(
      `INSERT INTO user_roles (user_id, role, status, source, onboarding_completed, onboarding_completed_at)
       VALUES ($1, $2, 'APPROVED', 'ADMIN', true, NOW())
       ON CONFLICT (user_id, role)
       DO UPDATE SET status = 'APPROVED', onboarding_completed = true, updated_at = NOW();`,
      [userId, role]
    );
  }

  return { id: userId, email, name, role };
}

async function seed({ reset = false } = {}) {
  const pool = await getPool();
  const results = { admins: [], sellers: [], buyers: [], providers: [] };

  if (reset) {
    console.log('\n── Reset requested: Clearing sessions & auth codes ──');
    await pool.query('DELETE FROM refresh_tokens;');
    await pool.query('DELETE FROM authorization_codes;');
  }

  // 1. Seed Admins
  console.log('\n── Seeding Admins ──');
  for (const adm of ADMINS) {
    const scope = { locations: ['*'], services: ['*'] };
    const user = await upsertUser(pool, {
      name: adm.name,
      email: adm.email,
      password: adm.password,
      phone: '+251911000000',
      role: 'ADMIN',
      adminScope: scope,
    });
    if (adm.isSuper) {
      await ensureSuperAdminRoleAssignment(pool, user.id);
    }
    results.admins.push(user);
  }

  // 2. Seed Sellers
  console.log('\n── Seeding Sellers ──');
  for (const sel of SELLERS) {
    const user = await upsertUser(pool, {
      name: sel.name,
      email: sel.email,
      password: sel.password,
      phone: sel.phone,
      role: 'SELLER',
      sellerStatus: 'APPROVED',
    });
    results.sellers.push(user);
  }

  // 3. Seed Buyers
  console.log('\n── Seeding Buyers ──');
  for (const buy of BUYERS) {
    const user = await upsertUser(pool, {
      name: buy.name,
      email: buy.email,
      password: buy.password,
      phone: buy.phone,
      role: 'BUYER',
      addresses: buy.addresses,
    });
    results.buyers.push(user);
  }

  // 4. Seed Providers
  console.log('\n── Seeding Delivery Providers ──');
  for (const prov of PROVIDERS) {
    const user = await upsertUser(pool, {
      name: prov.name,
      email: prov.email,
      password: prov.password,
      phone: prov.phone,
      role: 'PROVIDER',
    });
    results.providers.push(user);
  }

  console.log('\n' + '='.repeat(60));
  console.log('IDENTITY SEED COMPLETE');
  console.log('='.repeat(60));
  console.log('Credentials:');
  console.log('  Admins:');
  ADMINS.forEach((a) => console.log(`    ${a.email} / ${a.password}`));
  console.log('  Sellers:');
  SELLERS.forEach((s) => console.log(`    ${s.email} / ${s.password}`));
  console.log('  Buyers:');
  BUYERS.forEach((b) => console.log(`    ${b.email} / ${b.password}`));
  console.log('  Providers:');
  PROVIDERS.forEach((p) => console.log(`    ${p.email} / ${p.password}`));
  console.log('='.repeat(60));

  return results;
}

module.exports = { seed, ADMINS, SELLERS, BUYERS, PROVIDERS };

if (require.main === module) {
  const isReset = process.argv.includes('--reset');
  seed({ reset: isReset })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
