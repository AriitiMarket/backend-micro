// Authentication controller — OAuth 2.1 + OIDC endpoints.
//
// Token issuance happens ONLY at the token endpoint, via either:
//   * grant_type=authorization_code (PKCE S256 verified)
//   * grant_type=refresh_token   (rotation + reuse detection)
// Credential submission endpoints return a one-time authorization code — never
// tokens. There are no cookies and no server-side sessions anywhere.
const authService = require('../services/auth.service');
const usersService = require('../services/users.service');
const { resolveAdminAuthorization } = require('../services/adminAuthorization.service');
const { ok, created, fail } = require('../utils/response');
const env = require('../config/env');
const { resolveAvatar } = require('../config/imageRefs');

// RFC 6749 style error for token/authorize failures, while keeping `message`
// for the existing frontend envelope contract. `code` is the platform's
// machine-readable authorization code (INVALID_CREDENTIALS, ACCOUNT_DISABLED,
// ROLE_REQUIRED, ...) so every client can branch on one vocabulary.
function oauthFail(res, error, description, status = 400, code) {
  return res.status(status).json({
    success: false,
    error,
    error_description: description,
    message: description,
    errors: [],
    ...(code ? { code } : {}),
  });
}

// Validates a client_id/redirect_uri pair. First-party SPA clients exchange the
// code in-place, so an absent redirect_uri is allowed; any supplied redirect_uri
// must be explicitly allow-listed.
function assertClient(clientId, redirectUri) {
  if (clientId && env.allowedClients.length && !env.allowedClients.includes(clientId)) {
    const err = new Error('unauthorized_client');
    err.statusCode = 400;
    throw err;
  }
  if (redirectUri && env.allowedRedirectUris.length && !env.allowedRedirectUris.includes(redirectUri)) {
    const err = new Error('invalid_request: redirect_uri is not allow-listed');
    err.statusCode = 400;
    throw err;
  }
}

function readPkce(body, query) {
  return {
    codeChallenge: (body && body.code_challenge) || (query && query.code_challenge),
    codeChallengeMethod: (body && body.code_challenge_method) || (query && query.code_challenge_method) || 'S256',
  };
}

// ─ Register: create the account and issue an authorization code ──────────────
// (No tokens — the caller must complete the PKCE code exchange.)
async function register(req, res, next) {
  try {
    // File upload wins; otherwise accept an external URL or a real storage key.
    const avatar = resolveAvatar(req) || {};
    const { user } = await authService.registerCustomer({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      avatarPublicId: avatar.publicId || null,
      avatarUrl: avatar.url || null,
    });

    assertClient(req.body.client_id, req.body.redirect_uri);
    const pkce = readPkce(req.body, null);
    const code = await authService.createAuthorizationCode({
      userId: user.id,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      redirectUri: req.body.redirect_uri || null,
      scope: req.body.scope || 'openid profile email',
    });

    return created(res, {
      code: code.code,
      state: req.body.state || null,
      expires_in: code.expiresIn,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    }, 'User created successfully');
  } catch (err) {
    return next(err);
  }
}

// ─ Register with Role: create account with role-specific membership ──────────
// Supports BUYER, SELLER, PROVIDER registration paths. For SELLER and PROVIDER,
// creates a PENDING membership that requires admin approval.
async function registerWithRole(req, res, next) {
  try {
    const avatar = resolveAvatar(req) || {};
    const registrationType = req.params.role || req.body.registrationType;
    const { user } = await authService.registerWithRole({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      registrationType: registrationType,
      phoneNumber: req.body.phoneNumber || null,
      avatarPublicId: avatar.publicId || null,
      avatarUrl: avatar.url || null,
    });

    assertClient(req.body.client_id, req.body.redirect_uri);
    const pkce = readPkce(req.body, null);
    const code = await authService.createAuthorizationCode({
      userId: user.id,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      redirectUri: req.body.redirect_uri || null,
      scope: req.body.scope || 'openid profile email',
    });

    return created(res, {
      code: code.code,
      state: req.body.state || null,
      expires_in: code.expiresIn,
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role,
        registrationType 
      },
      message: registrationType === 'BUYER' 
        ? 'Buyer account created successfully' 
        : `${registrationType} application submitted and pending approval`,
    }, 'Registration successful');
  } catch (err) {
    return next(err);
  }
}

// ─ Authorization endpoint (direct credentials + PKCE) ───────────────────────
// The first-party SPA submits credentials together with the PKCE challenge and
// receives a one-time, PKCE-bound authorization code.
async function authorizeWithCredentials(req, res, next) {
  try {
    assertClient(req.body.client_id, req.body.redirect_uri);
    const { user, loginRole } = await authService.authenticateCredentials({
      email: req.body.email,
      password: req.body.password,
      // Which role the visitor signed in as (Buyer / Seller / Provider). The
      // account must have registered for that role — see resolveLoginRole.
      role: req.body.role,
    });
    const pkce = readPkce(req.body, null);
    const code = await authService.createAuthorizationCode({
      userId: user.id,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      redirectUri: req.body.redirect_uri || null,
      scope: req.body.scope || 'openid profile email',
    });
    return ok(res, {
      code: code.code,
      state: req.body.state || null,
      expires_in: code.expiresIn,
      login_role: loginRole || null,
    });
  } catch (err) {
    if (err.statusCode === 401) {
      return oauthFail(res, 'access_denied', 'Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }
    if (err.code === 'ACCOUNT_DISABLED') {
      return oauthFail(res, 'access_denied', err.message, 403, 'ACCOUNT_DISABLED');
    }
    // 403 = the credentials are right but the chosen sign-in role is not this
    // account's role. Surface the service's own message so the form can explain
    // which role to pick instead of showing a generic failure.
    if (err.statusCode === 403) {
      return res.status(403).json({
        success: false,
        error: 'role_mismatch',
        error_description: err.message,
        message: err.message,
        errors: [],
        code: 'ROLE_REQUIRED',
      });
    }
    return next(err);
  }
}

// ─ Authorization endpoint (already-authenticated consent flow) ───────────────
// Used when the principal already holds a valid access token (e.g. a second
// client requesting access, or a step-up authorization).
async function authorize(req, res, next) {
  try {
    const { response_type, client_id, redirect_uri, scope, state } = req.query;
    if (response_type !== 'code') {
      return oauthFail(res, 'unsupported_response_type', 'response_type must be "code"', 400);
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return oauthFail(res, 'login_required', 'Authorization endpoint requires an authenticated principal', 401);
    }
    let decoded;
    try {
      decoded = authService.verify(authHeader.split(' ')[1]);
    } catch (e) {
      return oauthFail(res, 'invalid_token', 'Access token is invalid or expired', 401);
    }

    assertClient(client_id, redirect_uri);
    const pkce = readPkce(null, req.query);
    const code = await authService.createAuthorizationCode({
      userId: decoded.sub,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      redirectUri: redirect_uri || null,
      scope: scope || 'openid profile email',
    });
    return ok(res, { code: code.code, state: state || null, expires_in: code.expiresIn });
  } catch (err) {
    return next(err);
  }
}

// ─ Token endpoint ───────────────────────────────────────────────────────────
async function tokenExchange(req, res, next) {
  try {
    const { grant_type, code, code_verifier, redirect_uri, refresh_token, client_id } = req.body;

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier) {
        return oauthFail(res, 'invalid_request', 'code and code_verifier are required', 400);
      }
      assertClient(client_id, redirect_uri);
      const result = await authService.exchangeAuthorizationCode(code, code_verifier, redirect_uri);
      return ok(res, {
        access_token: result.accessToken,
        id_token: result.idToken,
        refresh_token: result.refreshToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        scope: result.scope,
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return oauthFail(res, 'invalid_request', 'refresh_token is required', 400);
      }
      const result = await authService.refreshTokens(refresh_token);
      return ok(res, {
        access_token: result.accessToken,
        id_token: result.idToken,
        refresh_token: result.refreshToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
      });
    }

    return oauthFail(res, 'unsupported_grant_type', 'Supported grants: authorization_code, refresh_token', 400);
  } catch (err) {
    if (err.statusCode === 401 || /Invalid code verifier|Invalid or expired|already used|mismatch/.test(err.message)) {
      return oauthFail(res, 'invalid_grant', err.message, 400);
    }
    return next(err);
  }
}

// ─ Token endpoint alias: refresh grant only ─────────────────────────────────
async function refreshToken(req, res, next) {
  req.body.grant_type = 'refresh_token';
  return tokenExchange(req, res, next);
}

// ─ Token revocation (RFC 7009) ─────────────────────────────────────────────
async function revokeToken(req, res, next) {
  try {
    const { token } = req.body;
    if (token) {
      await authService.revokeRefreshToken(token);
    }
    // RFC 7009: always 200, even when the token was already invalid.
    return ok(res, {});
  } catch (err) {
    return next(err);
  }
}

// ─ Logout (revoke the presented refresh token) ──────────────────────────────
async function logoutUser(req, res, next) {
  try {
    const token = req.body.refresh_token;
    if (token) {
      await authService.revokeRefreshToken(token);
    }
    return ok(res, { message: 'Logout successful' });
  } catch (err) {
    return next(err);
  }
}

// ─ Switch active actor role ─────────────────────────────────────────────────
// One account can hold several actor roles (buyer + seller + provider). This
// selects which of them the session acts as, and re-mints the access token with
// that role. It cannot grant anything: the role must already be held.
async function switchRole(req, res, next) {
  try {
    const result = await authService.switchRole({
      userId: req.user.sub || req.user.id,
      role: req.body.role,
    });
    return ok(res, {
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      role: result.user.role,
      primary_role: result.user.primaryRole,
      capabilities: result.user.capabilities,
      user: result.user,
    });
  } catch (err) {
    return next(err);
  }
}

//  Get Current User ─────────────────────────────────────────────────────────
async function getCurrentUser(req, res, next) {
  try {
    const user = await usersService.getProfile({ userId: req.user.sub || req.user.id });
    // Surface the effective admin authorization so the console renders the real
    // admin role (SUPER_ADMIN / SELLER_ADMIN / ...) and the real permission set
    // instead of guessing from the coarse account role.
    const authorization = await resolveAdminAuthorization({
      id: user.id,
      role: user.role,
      adminScope: user.adminScope,
    });
    return ok(res, { user: { ...user, ...authorization } });
  } catch (err) {
    return next(err);
  }
}

// Map a membership status onto the platform's canonical authorization code so
// the portal guard and every service answer with the same vocabulary.
function statusCodeForRoleStatus(status) {
  switch (String(status || '').toUpperCase()) {
    case 'PENDING':
      return 'ROLE_NOT_APPROVED';
    case 'REJECTED':
      return 'ROLE_REJECTED';
    case 'SUSPENDED':
      return 'ROLE_SUSPENDED';
    case 'NOT_APPLIED':
      return 'ROLE_REQUIRED';
    default:
      return 'PERMISSION_DENIED';
  }
}

// Check role access status — returns status-aware information for portal access
async function checkRoleAccessStatus(req, res, next) {
  try {
    const { checkRoleAccess } = require('../middleware/roleAccess');
    const userId = req.user.sub || req.user.id;
    const role = req.params.role || req.query.role;
    
    if (!role) {
      return res.status(400).json({
        success: false,
        message: 'Role parameter is required',
      });
    }

    const access = await checkRoleAccess(userId, role);

    return ok(res, {
      role,
      allowed: access.allowed,
      status: access.status,
      message: access.message,
      code: access.allowed ? undefined : statusCodeForRoleStatus(access.status),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  register,
  registerWithRole,
  authorizeWithCredentials,
  authorize,
  tokenExchange,
  refreshToken,
  revokeToken,
  logoutUser,
  getCurrentUser,
  switchRole,
  checkRoleAccessStatus,
};
