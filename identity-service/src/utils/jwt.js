// JWT utilities — RS256 asymmetric signing, verification, and JWKS-compatible
// token management for OAuth 2.1 / OIDC.
//
// Rules enforced here (project auth contract):
//   * RS256 asymmetric signing only. No HMAC / shared-secret tokens, ever.
//   * Access tokens are short-lived (env.accessTokenExpiresIn, default 10m).
//   * PKCE is mandatory and S256-only; `plain` is rejected.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { privateKey, publicKey } = require('../config/keys');
const env = require('../config/env');

// kid must match the JWKS key id.
const KID = 'aritii-rs256-key-1';

// PKCE code_challenge / code_verifier: 43-128 chars, base64url (RFC 7636).
const BASE64URL_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

// Access token — short-lived, carries identity + role + admin authorization.
//
// `authorization` is the RBAC bridge (see adminAuthorization.service.js). It is
// only attached to ADMIN tokens: the downstream services read these claims from
// the gateway-injected headers, so they are what makes permission checks and
// admin data scoping enforceable outside the Identity Service.
function signAccessToken(user, authorization) {
  const payload = {
    sub: user.id,
    email: user.email,
    // The role the account is ACTING AS (a switchable actor role), not its home
    // role — see `primary_role` below.
    role: user.role,
    primary_role: user.primaryRole || user.role,
    type: 'access',
    scope: 'openid profile email',
  };
  // Multi-actor capability set: BUYER plus every ACTIVE actor membership
  // (SELLER / PROVIDER / AGENT). The single `role` claim cannot express "this
  // account is a seller AND a delivery provider", so the capability list travels
  // with the token and the gateway relays it as x-user-capabilities.
  if (Array.isArray(user.capabilities) && user.capabilities.length > 0) {
    payload.capabilities = user.capabilities;
  }
  // Membership STATUS per actor role (only roles with a `user_roles` row appear).
  // The gateway relays it as x-user-role-statuses so authorize() can answer a
  // pending / rejected / suspended application with a specific code instead of
  // a bare 403. Absent for tokens minted before the claim existed.
  if (user.roleStatuses && Object.keys(user.roleStatuses).length > 0) {
    payload.role_statuses = user.roleStatuses;
  }
  const isAdmin = user.role === 'ADMIN' ||
    user.role === 'SUPER_ADMIN' ||
    user.role === 'OPERATIONS_ADMIN' ||
    (typeof user.role === 'string' && user.role.toUpperCase().endsWith('_ADMIN'));
  if (authorization && isAdmin) {
    payload.admin_roles = authorization.adminRoles || [];
    payload.permissions = authorization.permissions || [];
    payload.admin_scope = authorization.adminScope || {};
  }
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: env.accessTokenExpiresIn,
    issuer: env.issuer,
    audience: env.audience,
    keyid: KID,
  });
}

// ID token (OIDC).
function signIdToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    type: 'id',
  };
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: env.accessTokenExpiresIn,
    issuer: env.issuer,
    audience: env.audience,
    keyid: KID,
  });
}

// 2FA temporary token — highly restricted, short-lived (5 min), 2FA-only.
// Only includes user ID, not full user context. Can ONLY be used for /auth/verify-2fa.
function sign2FAToken(userId) {
  const payload = {
    sub: userId,
    type: '2fa-temp',
    scope: 'verify-2fa-only',
  };
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: '5m', // 5 minutes, separate from access token expiry
    issuer: env.issuer,
    audience: env.audience,
    keyid: KID,
  });
}

// Verify (RS256 only, issuer/audience checked).
function verifyAccessToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: env.issuer,
    audience: env.audience,
  });
}

// Refresh token — opaque, high-entropy, stored hashed server-side.
function generateRefreshToken() {
  return crypto.randomBytes(40).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Authorization code — opaque, single-use, PKCE-bound, short-lived.
function generateAuthCode() {
  return crypto.randomBytes(32).toString('base64url');
}

// PKCE helpers (S256 only).
function isValidCodeChallenge(challenge, method) {
  if (method && method !== 'S256') return false;
  if (typeof challenge !== 'string') return false;
  return BASE64URL_RE.test(challenge);
}

function isValidCodeVerifier(verifier) {
  return typeof verifier === 'string' && BASE64URL_RE.test(verifier);
}

function computeS256Challenge(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function verifyPKCE(codeVerifier, codeChallenge, method) {
  // `plain` and every other method are rejected: S256 is the only supported
  // code challenge method (OAuth 2.1).
  if (method !== 'S256') return false;
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const computed = computeS256Challenge(codeVerifier);
  const a = Buffer.from(computed);
  const b = Buffer.from(String(codeChallenge || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  KID,
  signAccessToken,
  signIdToken,
  sign2FAToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  generateAuthCode,
  isValidCodeChallenge,
  isValidCodeVerifier,
  computeS256Challenge,
  verifyPKCE,
};
