// Role membership repository — the only layer that queries `user_roles`.
//
// One row per (account, actor role). The capability set a service sees is derived
// from these rows, so this table — not `users.role` — is the source of truth for
// "which actors is this account?".
const { getPool } = require('../config/database');

const MEMBERSHIP_COLUMNS = 'user_id, role, status, source, granted_at, updated_at';

function toMembership(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    role: row.role,
    status: row.status,
    source: row.source,
    grantedAt: row.granted_at,
    updatedAt: row.updated_at,
  };
}

/** Every membership row for one account (any status). */
async function listForUser(userId) {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM user_roles WHERE user_id = $1 ORDER BY granted_at ASC;`,
    [userId]
  );
  return result.rows.map(toMembership);
}

/**
 * Memberships for many accounts in one query.
 * Used by list endpoints so rendering N users never costs N queries.
 * @returns {Promise<Map<string, Array<object>>>} userId -> memberships
 */
async function listForUsers(userIds = []) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const byUser = new Map();
  if (ids.length === 0) return byUser;
  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM user_roles WHERE user_id = ANY($1::uuid[]) ORDER BY granted_at ASC;`,
    [ids]
  );
  for (const row of result.rows) {
    const membership = toMembership(row);
    const key = String(membership.userId);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(membership);
  }
  return byUser;
}

/**
 * Grant or update a membership. Writing the same (user, role) twice is expected:
 * an approval reactivates a previously suspended membership rather than failing
 * on the primary key.
 */
async function upsert(opts) {
  const { userId, role, status = 'ACTIVE', source = 'ADMIN' } = opts || {};
  const pool = await getPool();
  const result = await pool.query(
    `INSERT INTO user_roles (user_id, role, status, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, role)
     DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, updated_at = NOW()
     RETURNING ${MEMBERSHIP_COLUMNS};`,
    [userId, role, status, source]
  );
  return toMembership(result.rows[0]);
}

async function setStatus(opts) {
  const { userId, role, status } = opts || {};
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE user_roles SET status = $3, updated_at = NOW()
     WHERE user_id = $1 AND role = $2
     RETURNING ${MEMBERSHIP_COLUMNS};`,
    [userId, role, status]
  );
  return toMembership(result.rows[0]);
}

/** Drop a membership entirely (used when an application is withdrawn). */
async function remove(opts) {
  const { userId, role } = opts || {};
  const pool = await getPool();
  const result = await pool.query(
    'DELETE FROM user_roles WHERE user_id = $1 AND role = $2;',
    [userId, role]
  );
  return result.rowCount > 0;
}

/** Accounts holding a given actor role, optionally filtered by status. */
async function listByRole(opts = {}) {
  const { role, status, limit = 100, offset = 0 } = opts;
  const pool = await getPool();
  const params = [role];
  let where = 'role = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM user_roles
     WHERE ${where} ORDER BY granted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length};`,
    params
  );
  return result.rows.map(toMembership);
}

/** Counts by status for one actor role (admin pipeline views). */
async function countByStatus(role) {
  const pool = await getPool();
  const result = await pool.query(
    'SELECT status, COUNT(*)::int AS total FROM user_roles WHERE role = $1 GROUP BY status;',
    [role]
  );
  const out = {};
  let total = 0;
  for (const row of result.rows) {
    out[row.status] = row.total;
    total += row.total;
  }
  return { total, byStatus: out };
}

module.exports = {
  listForUser,
  listForUsers,
  upsert,
  setStatus,
  remove,
  listByRole,
  countByStatus,
  toMembership,
};
