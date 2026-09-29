// Authorization code repository — PKCE-bound, single-use, short-lived.
const crypto = require('crypto');
const { getPool } = require('../config/database');
const { hashToken } = require('../utils/jwt');

async function createAuthorizationCode({ userId, code, codeChallenge, codeChallengeMethod, redirectUri, scope, expiresInSec }) {
  const pool = await getPool();
  const id = crypto.randomUUID();
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);
  await pool.query(
    'INSERT INTO authorization_codes (id, user_id, code_hash, code_challenge, code_challenge_method, redirect_uri, scope, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, userId, codeHash, codeChallenge, codeChallengeMethod || 'S256', redirectUri || null, scope || 'openid profile email', expiresAt]
  );
  return { id, code, expiresAt };
}

async function findAuthorizationCode(code) {
  const pool = await getPool();
  const codeHash = hashToken(code);
  const result = await pool.query(
    'SELECT * FROM authorization_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()',
    [codeHash]
  );
  return result.rows[0] || null;
}

// Atomic single-use consumption. Returns true only for the caller that won the
// race, so a code can never be exchanged twice (including concurrently).
async function consumeAuthorizationCode(code) {
  const pool = await getPool();
  const codeHash = hashToken(code);
  const result = await pool.query(
    'UPDATE authorization_codes SET used_at = NOW() WHERE code_hash = $1 AND used_at IS NULL RETURNING id',
    [codeHash]
  );
  return result.rowCount === 1;
}

module.exports = { createAuthorizationCode, findAuthorizationCode, consumeAuthorizationCode };
