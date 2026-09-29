// Refresh token repository — rotation, revocation, and lifecycle.
// Tokens are stored as SHA-256 hashes; the raw value never touches the DB.
const crypto = require('crypto');
const { getPool } = require('../config/database');
const { hashToken } = require('../utils/jwt');

function expiryFrom(expiresInDays) {
  return new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
}

async function createRefreshToken({ userId, token, familyId, expiresInDays }) {
  const pool = await getPool();
  const id = crypto.randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = expiryFrom(expiresInDays);
  await pool.query(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [id, userId, tokenHash, familyId, expiresAt]
  );
  return { id, userId, familyId, expiresAt };
}

async function findRefreshToken(token) {
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const result = await pool.query(
    'SELECT * FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash]
  );
  return result.rows[0] || null;
}

// Atomic rotation: revoke the presented token and insert its successor inside a
// single transaction. Returns null when the presented token was already
// revoked/consumed (i.e. a concurrent replay), letting the caller revoke the
// whole family.
async function rotateRefreshToken({ oldTokenHash, userId, familyId, newToken, expiresInDays }) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revoked = await client.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id',
      [oldTokenHash]
    );
    if (revoked.rowCount !== 1) {
      await client.query('ROLLBACK');
      return null;
    }
    const id = crypto.randomUUID();
    const tokenHash = hashToken(newToken);
    const expiresAt = expiryFrom(expiresInDays);
    await client.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [id, userId, tokenHash, familyId, expiresAt]
    );
    await client.query('COMMIT');
    return { id, userId, familyId, expiresAt };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function revokeRefreshToken(token) {
  const pool = await getPool();
  const tokenHash = hashToken(token);
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
    [tokenHash]
  );
}

async function revokeFamily(familyId) {
  const pool = await getPool();
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1',
    [familyId]
  );
}

async function revokeAllForUser(userId) {
  const pool = await getPool();
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1',
    [userId]
  );
}

async function cleanupExpired() {
  const pool = await getPool();
  await pool.query('SELECT cleanup_expired_tokens()');
}

module.exports = {
  createRefreshToken,
  findRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeFamily,
  revokeAllForUser,
  cleanupExpired,
};
