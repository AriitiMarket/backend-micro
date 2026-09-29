// Authentication business logic — OAuth 2.1 + OIDC.
//
// This module is the ONLY place where end-user tokens are minted, and tokens are
// only ever produced by:
//   1. exchanging a PKCE-bound, single-use, short-lived authorization code
//   2. rotating a valid refresh token (rotation + reuse detection)
// There is no password grant, no implicit flow, and no cookie session.
const crypto = require('crypto');
const usersRepository = require('../repositories/users.repository');
const refreshTokensRepo = require('../repositories/refreshTokens.repository');
const authCodesRepo = require('../repositories/authorizationCodes.repository');
const userRolesRepo = require('../repositories/user-roles.repository');
const { hashPassword, comparePassword } = require('../utils/password');
const {
  signAccessToken,
  signIdToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  generateAuthCode,
  isValidCodeChallenge,
  verifyPKCE,
} = require('../utils/jwt');
const { toUser } = require('../models/User');
const { ROLES, normalizeRole } = require('../models/Role');

// Buyer access is implicit for every account. BUYER is the one canonical
// spelling of that actor across registration, sign-in, JWT claims and route
// gates (legacy `CUSTOMER` rows are canonicalized by models/Role.normalizeRole).
const BUYER_ROLE = 'BUYER';
const { resolveAdminAuthorization } = require('./adminAuthorization.service');
const env = require('../config/env');

const ACCESS_TOKEN_EXPIRES_IN_SEC = env.accessTokenExpiresInSec;

/**
 * Resolve which actor role a token should present.
 *
 * `role` in the token is the role the account is ACTING AS; `primary_role` keeps
 * the account's home role. A stored active role is honoured only while the
 * account still holds it (its membership can be suspended at any time), and an
 * ADMIN always acts as ADMIN so the console role can never be hidden.
 */
function withActiveRole(user) {
  const capabilities = Array.isArray(user.capabilities) ? user.capabilities : [];
  const primary = normalizeRole(user.role) || ROLES.BUYER;
  if (primary === ROLES.ADMIN) {
    return { ...user, role: primary, primaryRole: primary, capabilities };
  }
  const requested = (user.activeRole ? normalizeRole(user.activeRole) : primary) || primary;
  const resolved = requested === primary || capabilities.includes(requested) ? requested : primary;
  return { ...user, role: resolved, primaryRole: primary, capabilities };
}

/**
 * Switch which actor role the account is acting as.
 *
 * This is not a privilege change: the requested role must already be one the
 * account holds (an ACTIVE membership), so it can only ever select among roles
 * the account legitimately has. ADMIN can be neither switched into nor out of.
 */
async function switchRole(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  if (user.status !== 'active') {
    const err = new Error('Account is not active');
    err.statusCode = 403;
    throw err;
  }

  const primary = normalizeRole(user.role);
  // Legacy clients may still send `CUSTOMER` for the buyer actor.
  const requested = normalizeRole(payload.role);
  if (!requested) {
    const err = new Error('role is required');
    err.statusCode = 400;
    throw err;
  }

  if (primary === 'ADMIN' && requested !== 'ADMIN') {
    const err = new Error('An admin account always acts as ADMIN');
    err.statusCode = 409;
    throw err;
  }
  const capabilities = Array.isArray(user.capabilities) ? user.capabilities : [];
  if (requested !== primary && !capabilities.includes(requested)) {
    const err = new Error(`Your account does not hold the ${requested} role`);
    err.statusCode = 403;
    throw err;
  }

  // Persist the choice (null = back to the primary role) so the refresh grant
  // re-mints the same active role instead of reverting.
  const updated = await usersRepository.setActiveRole(user.id, requested === primary ? null : requested);
  const sessionUser = withActiveRole(updated);

  return {
    accessToken: signAccessToken(sessionUser, null),
    expiresIn: ACCESS_TOKEN_EXPIRES_IN_SEC,
    user: sessionUser,
  };
}

// Token pair creation — internal only (code exchange / rotation).
async function createTokenPair(user) {
  // Resolve the RBAC bridge before signing so the token carries the admin's
  // effective roles/permissions/scope — and the active actor role, so a switch
  // survives rotation.
  const sessionUser = withActiveRole(user);
  const authorization = await resolveAdminAuthorization(sessionUser);
  const accessToken = signAccessToken(sessionUser, authorization);
  const idToken = signIdToken(sessionUser);
  const refreshToken = generateRefreshToken();
  const familyId = crypto.randomUUID();

  await refreshTokensRepo.createRefreshToken({
    userId: user.id,
    token: refreshToken,
    familyId,
    expiresInDays: env.refreshTokenExpiresInDays,
  });

  return { accessToken, idToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRES_IN_SEC };
}

// Registration — creates the BUYER account only. No tokens are issued here; the
// caller must complete the authorization-code + PKCE exchange.
async function registerBuyer(payload) {
  // Trim here (not only in the validator): a stray space in a pasted address
  // must not create an account nobody can log into.
  const email = String(payload.email || '').trim();
  const existing = await usersRepository.findByEmail(email);
  if (existing) {
    const err = new Error('User Already Exists');
    err.statusCode = 409;
    throw err;
  }
  const passwordHash = await hashPassword(payload.password);
  const user = await usersRepository.create({
    name: payload.name,
    email: email,
    passwordHash: passwordHash,
    phoneNumber: payload.phoneNumber || null,
    role: BUYER_ROLE,
    avatarPublicId: payload.avatarPublicId || null,
    avatarUrl: payload.avatarUrl || null,
  });
  return { user };
}

// Role-specific registration — creates account and sets appropriate membership status
async function registerWithRole(payload) {
  const { MEMBERSHIP_STATUSES, MEMBERSHIP_SOURCES, ACTOR_ROLES } = require('../models/Role');
  
  const email = String(payload.email || '').trim();
  const existing = await usersRepository.findByEmail(email);
  if (existing) {
    const err = new Error('User Already Exists');
    err.statusCode = 409;
    throw err;
  }
  
  const passwordHash = await hashPassword(payload.password);
  const registrationType = String(payload.registrationType || 'BUYER').toUpperCase();
  
  // Create the base account as a BUYER (everyone starts as a buyer; the actor
  // application below only creates a PENDING membership, never a role grant).
  const user = await usersRepository.create({
    name: payload.name,
    email: email,
    passwordHash: passwordHash,
    phoneNumber: payload.phoneNumber || null,
    role: BUYER_ROLE,
    avatarPublicId: payload.avatarPublicId || null,
    avatarUrl: payload.avatarUrl || null,
  });
  
  // For SELLER and PROVIDER, create a PENDING membership
  if (ACTOR_ROLES.includes(registrationType)) {
    await userRolesRepo.upsert({
      userId: user.id,
      role: registrationType,
      status: MEMBERSHIP_STATUSES.PENDING,
      source: registrationType === 'SELLER' 
        ? MEMBERSHIP_SOURCES.SELLER_APPLICATION 
        : MEMBERSHIP_SOURCES.PROVIDER_APPLICATION,
    });
  }
  
  return { user, registrationType };
}

// Credential authentication — verifies a password and returns the principal.
// Deliberately does NOT issue tokens: the authorization endpoint turns this
// into a one-time code.
async function authenticateCredentials(payload) {
  const row = await usersRepository.findByEmailForLogin(String(payload.email || '').trim());
  // Identical error for unknown user and wrong password (no user enumeration).
  const invalid = () => {
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    return err;
  };
  if (!row) throw invalid();
  const valid = await comparePassword(payload.password, row.password_hash);
  if (!valid) throw invalid();
  const user = toUser(row);
  if (user.status !== 'active') {
    const err = new Error('Account is disabled. Contact platform support.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_DISABLED';
    throw err;
  }
  // An account signs in AS the role it registered for (see resolveLoginRole),
  // so signing in through another role's form is refused.
  const loginRole = await resolveLoginRole(user, payload.role);
  return { user, loginRole };
}

/**
 * The role an account is allowed to sign in as.
 *
 * Registration is role-specific (the sign-up form's Buyer / Seller / Provider
 * choice) and records a `user_roles` membership for the seller and provider
 * paths, so the membership table is the record of what the account registered
 * as. Sign-in is scoped to that one role: a seller account cannot sign in
 * through the buyer form (or the provider form), and a buyer cannot sign in as a
 * seller or provider.
 *
 * This is a sign-in gate only — it never grants a capability. The role the
 * session actually acts as still comes from the account's primary role plus its
 * ACTIVE memberships, so a seller whose application is still PENDING signs in
 * (and lands on their application screen) without gaining seller authority.
 *
 * @param {object} user - the authenticated principal (must carry `id` + `role`)
 * @param {string} [requestedRole] - BUYER | SELLER | PROVIDER, from the sign-in form
 * @returns {Promise<'BUYER'|'SELLER'|'PROVIDER'|'ADMIN'>}
 */
async function resolveLoginRole(user, requestedRole) {
  const primary = normalizeRole(user.role);

  // The admin console is a separate application with no actor role chooser: an
  // admin account always signs in as ADMIN.
  if (primary === ROLES.ADMIN) return ROLES.ADMIN;

  const memberships = await userRolesRepo.listForUser(user.id);
  const held = memberships.map((m) => normalizeRole(m.role));
  const ownRole = held.includes(ROLES.SELLER)
    ? ROLES.SELLER
    : held.includes(ROLES.PROVIDER)
      ? ROLES.PROVIDER
      : BUYER_ROLE;

  // No role supplied (older clients): sign in as the account's own role.
  // A legacy `CUSTOMER` value normalizes to BUYER before comparing.
  const requested = normalizeRole(String(requestedRole || ownRole).trim()) || ownRole;

  if (requested !== ownRole) {
    const err = new Error(
      ownRole === BUYER_ROLE
        ? `This account is not registered as a ${requested}. Please sign in as a buyer.`
        : `This account is registered as a ${ownRole}. Please sign in as ${ownRole}.`
    );
    err.statusCode = 403;
    throw err;
  }
  return requested;
}

// Authorization code — OAuth 2.1 + PKCE S256.
async function createAuthorizationCode({ userId, codeChallenge, codeChallengeMethod, redirectUri, scope }) {
  const method = codeChallengeMethod || 'S256';
  if (!isValidCodeChallenge(codeChallenge, method)) {
    const err = new Error('invalid_request: code_challenge must be a base64url S256 challenge');
    err.statusCode = 400;
    throw err;
  }
  const code = generateAuthCode();
  const authCode = await authCodesRepo.createAuthorizationCode({
    userId,
    code,
    codeChallenge,
    codeChallengeMethod: 'S256',
    redirectUri: redirectUri || null,
    scope: scope || 'openid profile email',
    expiresInSec: env.authorizationCodeExpiresInSec,
  });
  return { code: authCode.code, expiresIn: env.authorizationCodeExpiresInSec };
}

// Token endpoint: authorization_code grant.
async function exchangeAuthorizationCode(code, codeVerifier, redirectUri) {
  const record = await authCodesRepo.findAuthorizationCode(code);
  if (!record) {
    const err = new Error('Invalid or expired authorization code');
    err.statusCode = 400;
    throw err;
  }

  // PKCE (S256) is mandatory for every client.
  if (!verifyPKCE(codeVerifier, record.code_challenge, record.code_challenge_method)) {
    const err = new Error('Invalid code verifier');
    err.statusCode = 400;
    throw err;
  }

  // redirect_uri must match exactly when one was bound to the code.
  if (record.redirect_uri && record.redirect_uri !== redirectUri) {
    const err = new Error('redirect_uri mismatch');
    err.statusCode = 400;
    throw err;
  }

  // Single use: consume the code atomically before issuing anything.
  const consumed = await authCodesRepo.consumeAuthorizationCode(code);
  if (!consumed) {
    const err = new Error('Authorization code already used');
    err.statusCode = 400;
    throw err;
  }

  const user = await usersRepository.findById(record.user_id);
  if (!user || user.status !== 'active') {
    const err = new Error('User not found or inactive');
    err.statusCode = 401;
    throw err;
  }

  const tokens = await createTokenPair(user);
  return { ...tokens, scope: record.scope };
}

// Token endpoint: refresh_token grant (rotation + reuse detection).
async function refreshTokens(oldRefreshToken) {
  const record = await refreshTokensRepo.findRefreshToken(oldRefreshToken);
  if (!record) {
    const err = new Error('Invalid refresh token');
    err.statusCode = 401;
    throw err;
  }

  // Reuse detection — a revoked token presented again means the family leaked.
  if (record.revoked_at) {
    await refreshTokensRepo.revokeFamily(record.family_id);
    const err = new Error('Refresh token reuse detected. All sessions revoked.');
    err.statusCode = 401;
    throw err;
  }

  if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
    await refreshTokensRepo.revokeFamily(record.family_id);
    const err = new Error('Refresh token expired');
    err.statusCode = 401;
    throw err;
  }

  const user = await usersRepository.findById(record.user_id);
  if (!user || user.status !== 'active') {
    await refreshTokensRepo.revokeAllForUser(record.user_id);
    const err = new Error('User not found or inactive');
    err.statusCode = 401;
    throw err;
  }

  // Rotate atomically: revoke the presented token and insert its successor in
  // one transaction, so a concurrent replay can never mint two live tokens.
  const newRefreshToken = generateRefreshToken();
  const rotated = await refreshTokensRepo.rotateRefreshToken({
    oldTokenHash: hashToken(oldRefreshToken),
    userId: user.id,
    familyId: record.family_id,
    newToken: newRefreshToken,
    expiresInDays: env.refreshTokenExpiresInDays,
  });

  if (!rotated) {
    await refreshTokensRepo.revokeFamily(record.family_id);
    const err = new Error('Refresh token reuse detected. All sessions revoked.');
    err.statusCode = 401;
    throw err;
  }

  // Preserve the account's active actor role across rotation: without this, a
  // deliberate switch would silently revert to the primary role as soon as the
  // access token was refreshed.
  const sessionUser = withActiveRole(user);
  const authorization = await resolveAdminAuthorization(sessionUser);

  return {
    accessToken: signAccessToken(sessionUser, authorization),
    idToken: signIdToken(sessionUser),
    refreshToken: newRefreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRES_IN_SEC,
  };
}

async function revokeRefreshToken(token) {
  await refreshTokensRepo.revokeRefreshToken(token);
}

async function revokeAllUserTokens(userId) {
  await refreshTokensRepo.revokeAllForUser(userId);
}

// Used by JWKS-backed consumers.
function verify(token) {
  return verifyAccessToken(token);
}

module.exports = {
  // Legacy alias: the buyer registration entry point keeps its old name for
  // callers that already import it.
  registerBuyer,
  registerCustomer: registerBuyer,
  registerWithRole,
  authenticateCredentials,
  resolveLoginRole,
  refreshTokens,
  revokeRefreshToken,
  revokeAllUserTokens,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  switchRole,
  withActiveRole,
  verify,
  ACCESS_TOKEN_EXPIRES_IN_SEC,
};
