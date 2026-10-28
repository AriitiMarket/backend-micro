// Seed admin users for the Aritii Market admin panel (2-role system).
// Usage:
//   docker compose exec identity-service node src/seed/seed-admin.js
//
// Environment variables (optional):
//   ADMIN_EMAIL (default: admin@aritii.com) — the platform's canonical admin
//   ADMIN_PASSWORD (default: Admin@12345)
//   SUPER_ADMIN_EMAIL (default: superadmin@aritii.com)
//   SUPER_ADMIN_PASSWORD (default: SuperAdmin@123)
//   OPERATIONS_ADMIN_EMAIL (default: opsadmin@aritii.com)
//   OPERATIONS_ADMIN_PASSWORD (default: OpsAdmin@123)

const { getPool } = require('../config/database');
const { hashPassword } = require('../utils/password');
const crypto = require('crypto');

const TEST_ADMINS = [
  {
    // The canonical admin of the platform (README + the E2E suites use it).
    // It carries the unrestricted SUPER_ADMIN role.
    email: process.env.ADMIN_EMAIL || 'admin@aritii.com',
    password: process.env.ADMIN_PASSWORD || 'Admin@12345',
    name: 'Aritii Admin',
    role: 'SUPER_ADMIN',
  },
  {
    email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@aritii.com',
    password: process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123',
    name: 'Super Administrator',
    role: 'SUPER_ADMIN',
  },
  {
    email: process.env.OPERATIONS_ADMIN_EMAIL || 'opsadmin@aritii.com',
    password: process.env.OPERATIONS_ADMIN_PASSWORD || 'OpsAdmin@123',
    name: 'Operations Administrator',
    role: 'OPERATIONS_ADMIN',
  },
  {
    email: 'nadhiijemal503@gmail.com',
    password: 'Admin@12345',
    name: 'Nadhii Jemal',
    role: 'SUPER_ADMIN',
  },
];

const SUPPORTED_ROLES = new Set(['SUPER_ADMIN', 'OPERATIONS_ADMIN']);

async function seed() {
  const pool = await getPool();

  console.log('Seeding admin test accounts...\n');

  for (const admin of TEST_ADMINS) {
    if (!SUPPORTED_ROLES.has(admin.role)) {
      throw new Error(`Unsupported role "${admin.role}". Use SUPER_ADMIN or OPERATIONS_ADMIN.`);
    }

    // Check if admin already exists
    const existing = await pool.query('SELECT id, role FROM users WHERE email = $1;', [admin.email]);
    const passwordHash = await hashPassword(admin.password);
    
    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await pool.query(
        'UPDATE users SET password_hash = $1, role = $2, status = $3, is_verified = $4, admin_scope = $5 WHERE id = $6;',
        [passwordHash, 'ADMIN', 'active', true, JSON.stringify({ locations: ['*'], services: ['*'] }), userId]
      );
      console.log(`✓ ${admin.email} already exists — password and role updated`);
    } else {
      userId = crypto.randomUUID();
      
      await pool.query(
        'INSERT INTO users (id, name, email, password_hash, role, status, is_verified, admin_scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);',
        [userId, admin.name, admin.email, passwordHash, 'ADMIN', 'active', true, JSON.stringify({ locations: ['*'], services: ['*'] })]
      );
      
      console.log(`✓ Created: ${admin.email}`);
    }

    // Assign role
    await ensureAdminRoleAssignment(pool, userId, admin.role);
    console.log(`✓ Role assigned: ${admin.role}`);
    console.log(`  Email: ${admin.email}`);
    console.log(`  Password: ${admin.password}`);
    console.log();
  }

  console.log('✅ Seed complete!\n');
  console.log('Test Accounts:');
  console.log('─────────────────────────────────────────────');
  for (const admin of TEST_ADMINS) {
    console.log(`${admin.role}`);
    console.log(`  Email: ${admin.email}`);
    console.log(`  Password: ${admin.password}`);
    console.log();
  }
}

async function ensureAdminRoleAssignment(pool, userId, roleName) {
  const role = await pool.query('SELECT id FROM admin_roles WHERE name = $1;', [roleName]);
  
  if (!role.rows[0]) {
    throw new Error(
      `${roleName} role not found in admin_roles table. Run migration first: node src/migrations/002-migrate-roles.js`
    );
  }

  // Remove stale role assignments
  await pool.query(
    `DELETE FROM admin_user_roles
     WHERE user_id = $1 AND role_id <> $2;`,
    [userId, role.rows[0].id]
  );

  // Assign the new role
  await pool.query(
    `INSERT INTO admin_user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) DO NOTHING;`,
    [userId, role.rows[0].id]
  );
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  });
