// Agent repository — only layer that queries the agents table.
const { getPool } = require('../config/database');
const { toAgent } = require('../models/Agent');

const AGENT_COLUMNS = 'id, user_id, sector_id, commission_rate, is_active, verification_status, documents, rating, total_transactions, created_at, updated_at';

// Match PostgreSQL's UUID format so invalid strings become "not found" (404) instead of a 500 cast error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Run a parameterized query but convert invalid-UUID input into a no-match (null) result.
async function safeLookup(sql, id) {
  if (!isUuid(id)) return null;
  const pool = await getPool();
  const result = await pool.query(sql, [id]);
  return result.rows[0] ? toAgent(result.rows[0]) : null;
}

async function findById(id) {
  return safeLookup(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1;`, id);
}

async function findByUserId(userId) {
  return safeLookup(`SELECT ${AGENT_COLUMNS} FROM agents WHERE user_id = $1;`, userId);
}

async function findAll() {
  const pool = await getPool();
  const result = await pool.query(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY created_at DESC;`);
  return result.rows.map(toAgent);
}

async function create(opts) {
  const pool = await getPool();
  const result = await pool.query(
    `INSERT INTO agents (user_id, sector_id, commission_rate)
     VALUES ($1, $2, $3) RETURNING id;`,
    [opts.userId, opts.sectorId || null, opts.commissionRate != null ? opts.commissionRate : 5.0]
  );
  return findById(result.rows[0].id);
}

async function updateFields(opts) {
  const pool = await getPool();
  const id = opts.id;
  const fields = opts.fields;
  const keys = Object.keys(fields);
  if (keys.length < 1) return findById(id);
  const assignments = keys.map(function (key, index) {
    return key + ' = $' + (index + 1);
  });
  const values = Object.values(fields);
  values.push(id);
  const setSql = assignments.join(', ') + ', updated_at = NOW()';
  await pool.query('UPDATE agents SET ' + setSql + ' WHERE id = $' + values.length + ';', values);
  return findById(id);
}

module.exports = {
  findById,
  findByUserId,
  findAll,
  create,
  updateFields,
};