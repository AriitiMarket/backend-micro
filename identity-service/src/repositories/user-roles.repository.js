// Role membership repository — the only layer that queries `user_roles`.
//
// One row per (account, actor role). The capability set a service sees is derived
// from these rows, so this table — not `users.role` — is the source of truth for
// "which actors is this account?".
//
// Every function accepts an optional `client`. When one is supplied the query
// runs on that connection, which is how the service layer composes several writes
// into a single transaction (see config/transaction.js). Without one the shared
// pool is used, so existing single-statement callers are unchanged.
const { getPool } = require('../config/database');

const MEMBERSHIP_COLUMNS = 'user_id, role, status, source, granted_at, updated_at, onboarding_completed, onboarding_started_at, onboarding_completed_at';

/** Resolve the query connection: an in-transaction client, or the shared pool. */
async function runner(client) {
  return client || (await getPool());
}

function toMembership(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    role: row.role,
    status: row.status,
    source: row.source,
    grantedAt: row.granted_at,
    updatedAt: row.updated_at,
    // Onboarding of the role-specific wizard. `false` on a PENDING membership
    // means "registered, never submitted" — exactly what the abandoned sweep
    // reclaims. A submitted application is `true` (under review, not abandoned).
    onboardingCompleted: row.onboarding_completed,
    onboardingStartedAt: row.onboarding_started_at,
    onboardingCompletedAt: row.onboarding_completed_at,
  };
}

/** Every membership row for one account (any status). */
async function listForUser(userId, options = {}) {
  const db = await runner(options.client);
  const result = await db.query(
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
async function listForUsers(userIds = [], options = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const byUser = new Map();
  if (ids.length === 0) return byUser;
  const db = await runner(options.client);
  const result = await db.query(
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
  const { userId, role, status = 'ACTIVE', source = 'ADMIN', client } = opts || {};
  // An actor application membership is created INCOMPLETE (the applicant still
  // has to finish the store/vehicle wizard); an admin/system grant is inherently
  // complete. Callers opt into the former with `onboardingCompleted: false`.
  const onboardingCompleted = opts.onboardingCompleted !== undefined ? Boolean(opts.onboardingCompleted) : true;
  const db = await runner(client);
  const result = await db.query(
    `INSERT INTO user_roles
       (user_id, role, status, source, onboarding_completed, onboarding_started_at, onboarding_completed_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $5 THEN NULL ELSE NOW() END,
             CASE WHEN $5 THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, role)
     DO UPDATE SET
       status = EXCLUDED.status,
       source = EXCLUDED.source,
       onboarding_completed = EXCLUDED.onboarding_completed,
       onboarding_started_at = CASE
         WHEN EXCLUDED.onboarding_completed THEN user_roles.onboarding_started_at
         ELSE COALESCE(user_roles.onboarding_started_at, NOW())
       END,
       onboarding_completed_at = CASE
         WHEN EXCLUDED.onboarding_completed THEN COALESCE(user_roles.onboarding_completed_at, NOW())
         ELSE NULL
       END,
       updated_at = NOW()
     RETURNING ${MEMBERSHIP_COLUMNS};`,
    [userId, role, status, source, onboardingCompleted]
  );
  return toMembership(result.rows[0]);
}

async function setStatus(opts) {
  const { userId, role, status, client } = opts || {};
  const db = await runner(client);
  const result = await db.query(
    `UPDATE user_roles SET status = $3, updated_at = NOW()
     WHERE user_id = $1 AND role = $2
     RETURNING ${MEMBERSHIP_COLUMNS};`,
    [userId, role, status]
  );
  return toMembership(result.rows[0]);
}

/**
 * Mark the role-specific wizard as finished for a membership.
 *
 * Called when the applicant finally submits the full store/vehicle application
 * (relayed by Commerce/Delivery) and again when an admin approves — idempotent
 * both ways. Only onboarding columns are touched, so an application that is still
 * PENDING (waiting for a reviewer) stays PENDING and is never swept — being
 * complete is what separates "under review" from "abandoned".
 */
async function completeOnboarding(opts) {
  const { userId, role, client } = opts || {};
  const db = await runner(client);
  const result = await db.query(
    `UPDATE user_roles
        SET onboarding_completed = true,
            onboarding_started_at = COALESCE(onboarding_started_at, NOW()),
            onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
            updated_at = NOW()
      WHERE user_id = $1 AND role = $2
      RETURNING ${MEMBERSHIP_COLUMNS};`,
    [userId, role]
  );
  return toMembership(result.rows[0]);
}

/** Drop a membership entirely (used when an application is withdrawn). */
async function remove(opts) {
  const { userId, role, client } = opts || {};
  const db = await runner(client);
  const result = await db.query(
    'DELETE FROM user_roles WHERE user_id = $1 AND role = $2;',
    [userId, role]
  );
  return result.rowCount > 0;
}

/**
 * Abandoned applications: memberships still PENDING whose wizard was never
 * finished and whose last activity is older than the window.
 *
 * A submitted application has `onboarding_completed = true` and is deliberately
 * NOT selected — it is waiting for a reviewer, not abandoned. The age is measured
 * from when onboarding started (falling back to the grant time for rows that
 * predate the column), which is the closest thing to "last time they touched it".
 */
async function listAbandonedPending(opts = {}) {
  const { olderThanDays = 30, limit = 500, client } = opts;
  const db = await runner(client);
  const result = await db.query(
    `SELECT ${MEMBERSHIP_COLUMNS}
       FROM user_roles
      WHERE status = 'PENDING'
        AND onboarding_completed = false
        AND COALESCE(onboarding_started_at, granted_at) < NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY COALESCE(onboarding_started_at, granted_at) ASC
      LIMIT $2;`,
    [olderThanDays, limit]
  );
  return result.rows.map(toMembership);
}

/**
 * Delete the given `{ userId, role }` memberships in one statement.
 * @returns {Promise<number>} rows removed
 */
async function deleteMemberships(pairs, options = {}) {
  const list = (pairs || []).filter((pair) => pair && pair.userId && pair.role);
  if (list.length === 0) return 0;
  const db = await runner(options.client);
  const result = await db.query(
    `DELETE FROM user_roles ur
      USING unnest($1::uuid[], $2::text[]) AS doomed(user_id, role_name)
     WHERE ur.user_id = doomed.user_id AND ur.role = doomed.role_name;`,
    [list.map((pair) => String(pair.userId)), list.map((pair) => String(pair.role))]
  );
  return result.rowCount;
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
  completeOnboarding,
  remove,
  listAbandonedPending,
  deleteMemberships,
  listByRole,
  countByStatus,
  toMembership,
};
