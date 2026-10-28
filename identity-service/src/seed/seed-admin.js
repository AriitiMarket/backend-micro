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
    
    let userId;
    const passwordHash = await hashPassword(admin.password);
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users
         SET name = $1, password_hash = $2, role = 'ADMIN', status = 'active', is_verified = true,
             admin_scope = $3::jsonb, updated_at = NOW()
         WHERE id = $4;`,
        [admin.name, passwordHash, JSON.stringify({ locations: ['*'], services: ['*'] }), userId]
      );
      console.log(`✓ Updated: ${admin.email}`);
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
  let role = await pool.query('SELECT id FROM admin_roles WHERE name = $1;', [roleName]);
  
  if (!role.rows[0]) {
    const defaultPerms = roleName === 'SUPER_ADMIN'
      ? ['*']
      : [
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
    const inserted = await pool.query(
      `INSERT INTO admin_roles (name, display_name, description, permissions, is_system)
       VALUES ($1, $2, $3, $4::jsonb, true)
       RETURNING id;`,
      [
        roleName,
        roleName === 'SUPER_ADMIN' ? 'Super Admin' : 'Operations Admin',
        roleName === 'SUPER_ADMIN' ? 'Full system access' : 'Operations Administrator',
        JSON.stringify(defaultPerms),
      ]
    );
    role = inserted;
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
