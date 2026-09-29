// Role repository — only place that queries the roles table.
const { getPool } = require('../config/database');

async function getRoles() {
  const pool = await getPool();
  const result = await pool.query('SELECT id, name FROM roles ORDER BY name;');
  return result.rows;
}

async function ensureRole(name) {
  const pool = await getPool();
  await pool.query('INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING;', [name]);
}

module.exports = { getRoles, ensureRole };