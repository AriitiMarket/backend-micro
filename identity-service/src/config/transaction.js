// Database transaction helper.
//
// The Identity Service is the only writer of account roles and status, and a
// single logical state change here is frequently MORE THAN ONE statement:
//
//   * role-specific registration  -> INSERT users + INSERT user_roles (PENDING)
//   * seller/provider approval    -> UPDATE user_roles.status + UPDATE users.role
//   * suspend / reactivate        -> UPDATE user_roles.status + UPDATE users.seller_status
//   * onboarding completion       -> UPDATE user_roles.onboarding_*
//
// Without a transaction a crash (or a failing second statement) leaves the two
// tables disagreeing about what the account actually is — e.g. an ACTIVE
// membership whose primary role was never promoted, or a promoted primary role
// whose membership still reads PENDING. Every such operation must therefore run
// inside BEGIN / COMMIT / ROLLBACK.
//
// The pool is injectable so the helper (and everything built on it) can be unit
// tested without a live PostgreSQL.
const { getPool } = require('./database');

/**
 * Run `fn` inside a single database transaction, committing on success and
 * rolling back on any error. The connection is always released.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ pool?: import('pg').Pool }} [options] optional pool override (tests)
 * @returns {Promise<T>}
 */
async function withTransaction(fn, options = {}) {
  const pool = options.pool || (await getPool());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is already gone (e.g. the server closed it); the original
      // error is the one that matters, so it is never masked by this one.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
