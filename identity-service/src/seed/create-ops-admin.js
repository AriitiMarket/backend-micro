#!/usr/bin/env node
/**
 * Provision / Insert an Operations Administrator into Identity Service.
 *
 * Usage:
 *   node src/seed/create-ops-admin.js [email] [password] [name]
 *
 * Examples:
 *   node src/seed/create-ops-admin.js
 *   node src/seed/create-ops-admin.js ops@aritii.com OpsAdmin@123 "Ops Admin"
 *
 * It will:
 *   1. Check / create the OPERATIONS_ADMIN system role with restricted permissions
 *      (Orders, Delivery, Disputes, Shops, Products, Catalog, Reports).
 *      EXCLUDES: Users Management, Transactions, Platform Settings, Commissions.
 *   2. Hash the password with bcrypt (10 rounds).
 *   3. Upsert into `users` (role='ADMIN', status='active', is_verified=true).
 *   4. Link in `admin_user_roles` to OPERATIONS_ADMIN.
 *   5. Output verified credentials and raw SQL fallback for direct execution.
 */
const { getPool } = require('../config/database');
const { hashPassword } = require('../utils/password');
const crypto = require('crypto');

const email = process.argv[2] || process.env.OPERATIONS_ADMIN_EMAIL || 'opsadmin@aritii.com';
const password = process.argv[3] || process.env.OPERATIONS_ADMIN_PASSWORD || 'OpsAdmin@123';
const name = process.argv[4] || 'Operations Administrator';

const OPS_PERMISSIONS = [
  'dashboard.view',
  'businesses.view',
  'shops.view',
  'locations.view',
  'orders.view',
  'orders.manage',
  'delivery.view',
  'delivery.manage',
  'disputes.view',
  'disputes.manage',
  'reports.view',
];

async function main() {
  console.log('────────────────────────────────────────────────────────');
  console.log('  Ariiti Market — Provision Operations Administrator');
  console.log('────────────────────────────────────────────────────────\n');

  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    console.warn('⚠️ Could not connect directly to local PostgreSQL pool: ' + err.message);
    console.log('\nGenerating ready-to-run SQL statements below instead...\n');
    printSql(email, password, name);
    return;
  }

  try {
    // 1. Ensure OPERATIONS_ADMIN exists in admin_roles with correct restricted permissions
    console.log('Step 1: Ensuring OPERATIONS_ADMIN role exists...');
    let roleRes = await pool.query('SELECT id, permissions FROM admin_roles WHERE name = $1;', ['OPERATIONS_ADMIN']);
    let roleId;
    if (roleRes.rows.length === 0) {
      const insRole = await pool.query(
        `INSERT INTO admin_roles (name, display_name, description, permissions, is_system)
         VALUES ($1, $2, $3, $4::jsonb, true)
         RETURNING id;`,
        [
          'OPERATIONS_ADMIN',
          'Operations Admin',
          'Runs daily orders, delivery, and dispute operations without access to RBAC, platform settings, financial configuration, transactions, or user management',
          JSON.stringify(OPS_PERMISSIONS),
        ]
      );
      roleId = insRole.rows[0].id;
      console.log(`  ✓ Created OPERATIONS_ADMIN role (ID: ${roleId})`);
    } else {
      roleId = roleRes.rows[0].id;
      await pool.query(
        `UPDATE admin_roles
         SET permissions = $1::jsonb, updated_at = NOW()
         WHERE id = $2;`,
        [JSON.stringify(OPS_PERMISSIONS), roleId]
      );
      console.log(`  ✓ OPERATIONS_ADMIN role confirmed (ID: ${roleId})`);
    }

    // 2. Hash password
    console.log('Step 2: Hashing password...');
    const passwordHash = await hashPassword(password);

    // 3. Upsert user in `users`
    console.log(`Step 3: Upserting user ${email}...`);
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1);', [email]);
    let userId;
    const scope = JSON.stringify({ locations: ['*'], services: ['*'] });

    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users
         SET name = $1, password_hash = $2, role = 'ADMIN', status = 'active', is_verified = true,
             admin_scope = $3::jsonb, two_factor_enabled = false, updated_at = NOW()
         WHERE id = $4;`,
        [name, passwordHash, scope, userId]
      );
      console.log(`  ✓ Updated existing user ${email} (ID: ${userId})`);
    } else {
      userId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, role, status, is_verified, admin_scope)
         VALUES ($1, $2, $3, $4, 'ADMIN', 'active', true, $5::jsonb);`,
        [userId, name, email.toLowerCase().trim(), passwordHash, scope]
      );
      console.log(`  ✓ Created new user ${email} (ID: ${userId})`);
    }

    // 4. Link in admin_user_roles
    console.log('Step 4: Assigning OPERATIONS_ADMIN role assignment...');
    await pool.query('DELETE FROM admin_user_roles WHERE user_id = $1;', [userId]);
    await pool.query(
      `INSERT INTO admin_user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, role_id) DO NOTHING;`,
      [userId, roleId]
    );
    console.log(`  ✓ Linked user to OPERATIONS_ADMIN role`);

    console.log('\n────────────────────────────────────────────────────────');
    console.log('✅ Operations Administrator successfully provisioned!');
    console.log('────────────────────────────────────────────────────────');
    console.log(`  Email:       ${email}`);
    console.log(`  Password:    ${password}`);
    console.log(`  Role:        OPERATIONS_ADMIN`);
    console.log(`  Permissions: ${OPS_PERMISSIONS.join(', ')}`);
    console.log('────────────────────────────────────────────────────────\n');
  } catch (err) {
    console.error('❌ Provisioning failed:', err.message);
    console.log('\nFallback SQL for direct execution in database:');
    printSql(email, password, name);
    process.exit(1);
  } finally {
    if (pool?.end) await pool.end();
  }
}

function printSql(emailVal, passVal, nameVal) {
  // Generate bcrypt hash for the password
  const bcrypt = require('bcryptjs');
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(passVal, salt);

  console.log(`-- ────────────────────────────────────────────────────────────`);
  console.log(`-- DIRECT SQL SCRIPT TO INSERT/UPDATE OPERATIONS ADMIN IN POSTGRESQL`);
  console.log(`-- ────────────────────────────────────────────────────────────\n`);
  console.log(`-- 1. Ensure the OPERATIONS_ADMIN system role exists`);
  console.log(`INSERT INTO admin_roles (name, display_name, description, permissions, is_system)
VALUES (
  'OPERATIONS_ADMIN',
  'Operations Admin',
  'Runs daily orders, delivery, and dispute operations without access to RBAC, platform settings, financial configuration, transactions, or user management',
  '${JSON.stringify(OPS_PERMISSIONS)}'::jsonb,
  true
)
ON CONFLICT (name) DO UPDATE SET
  permissions = EXCLUDED.permissions,
  updated_at = NOW();\n`);

  console.log(`-- 2. Insert or update the user`);
  console.log(`INSERT INTO users (
  id, name, email, password_hash, role, status, is_verified, admin_scope
) VALUES (
  gen_random_uuid(),
  '${nameVal.replace(/'/g, "''")}',
  '${emailVal.toLowerCase().trim()}',
  '${hash}',
  'ADMIN',
  'active',
  true,
  '{"locations":["*"],"services":["*"]}'::jsonb
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  password_hash = EXCLUDED.password_hash,
  role = 'ADMIN',
  status = 'active',
  is_verified = true,
  admin_scope = EXCLUDED.admin_scope,
  two_factor_enabled = false,
  updated_at = NOW();\n`);

  console.log(`-- 3. Link the user in admin_user_roles`);
  console.log(`INSERT INTO admin_user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
CROSS JOIN admin_roles r
WHERE LOWER(u.email) = LOWER('${emailVal.toLowerCase().trim()}')
  AND r.name = 'OPERATIONS_ADMIN'
ON CONFLICT (user_id, role_id) DO NOTHING;\n`);
  console.log(`-- ────────────────────────────────────────────────────────────`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
