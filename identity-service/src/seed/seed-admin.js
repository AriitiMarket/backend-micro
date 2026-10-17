// Seed an admin user for the Aritii Market admin panel.
// Usage: docker compose exec identity-service node src/seed/seed-admin.js
const { getPool } = require('../config/database');
const { hashPassword } = require('../utils/password');
const crypto = require('crypto');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@aritii.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Aritii Admin';
const ADMIN_ROLE = process.env.ADMIN_ROLE || 'SUPER_ADMIN';

const SUPPORTED_ADMIN_ROLES = new Set([
  'SUPER_ADMIN',
  'OPERATIONAL_ADMIN',
]);

if (!SUPPORTED_ADMIN_ROLES.has(ADMIN_ROLE)) {
  throw new Error(
    `Unsupported ADMIN_ROLE "${ADMIN_ROLE}". Use SUPER_ADMIN or OPERATIONAL_ADMIN.`
  );
}

async function seed() {
  const pool = await getPool();

  // Check if admin already exists
  const existing = await pool.query('SELECT id, role FROM users WHERE email = $1;', [ADMIN_EMAIL]);
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.role !== 'ADMIN') {
      await pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2;', ['ADMIN', row.id]);
      console.log(`User ${ADMIN_EMAIL} upgraded to ADMIN`);
    } else {
      console.log(`Admin ${ADMIN_EMAIL} already exists (id: ${row.id})`);
    }
    await ensureAdminRoleAssignment(pool, row.id);
    return;
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await pool.query(
    'INSERT INTO users (id, name, email, password_hash, role, status, is_verified, admin_scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);',
    [id, ADMIN_NAME, ADMIN_EMAIL, passwordHash, 'ADMIN', 'active', true, JSON.stringify({ locations: ['*'], services: ['*'] })]
  );
  await ensureAdminRoleAssignment(pool, id);
  console.log(`Admin created: ${ADMIN_EMAIL} (id: ${id})`);
  console.log(`Admin role: ${ADMIN_ROLE}`);
  console.log(`Scope: all locations, all services`);
}

async function ensureAdminRoleAssignment(pool, userId) {
  const role = await pool.query('SELECT id FROM admin_roles WHERE name = $1;', [ADMIN_ROLE]);
  if (!role.rows[0]) {
    throw new Error(
      `${ADMIN_ROLE} role is not seeded; initialize the Identity database first`
    );
  }
  await pool.query(
    `INSERT INTO admin_user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) DO NOTHING;`,
    [userId, role.rows[0].id]
  );
}

seed().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
