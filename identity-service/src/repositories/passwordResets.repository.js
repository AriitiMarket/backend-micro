// Password reset repository — single-use reset token lifecycle and management.
const { getPool } = require('../config/database');

async function createPasswordReset({ userId, tokenHash, expiresAt, ipAddress, userAgent }) {
  const pool = await getPool();
  // Invalidate any existing unused reset tokens for this user first
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
  const result = await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, expires_at, created_at`,
    [userId, tokenHash, expiresAt, ipAddress || null, userAgent || null]
  );
  return result.rows[0];
}

async function findValidReset(tokenHash) {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT pr.*, u.email, u.name, u.role, u.status
     FROM password_resets pr
     JOIN users u ON pr.user_id = u.id
     WHERE pr.token_hash = $1
       AND pr.used_at IS NULL
       AND pr.expires_at > NOW()`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function markUsed(id) {
  const pool = await getPool();
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE id = $1',
    [id]
  );
}

async function invalidateAllForUser(userId) {
  const pool = await getPool();
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );
}

module.exports = {
  createPasswordReset,
  findValidReset,
  markUsed,
  invalidateAllForUser,
};
