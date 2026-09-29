// Authentication routes — OAuth 2.1 + OIDC. Token-based only, no cookies.
//
// Flow (Authorization Code + PKCE S256):
//   1. client generates code_verifier/code_challenge (S256)
//   2. POST /auth/authorize   (credentials + code_challenge)  -> one-time code
//      or POST /auth/register (new account + code_challenge)  -> one-time code
//      or GET  /auth/authorize (Bearer token, consent)        -> one-time code
//   3. POST /auth/token       (grant_type=authorization_code, code + verifier)
//   4. POST /auth/token       (grant_type=refresh_token) to rotate the session
// There is no password grant and no implicit flow: no endpoint other than the
// token endpoint ever returns a token.
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const authenticate = require('../middleware/authenticate');
const { uploadUserFile } = require('../config/upload');
const {
  validateAuthorize,
  validateRegister,
  validateLogin,
  validateRoleRegistration,
} = require('../validators/auth.validators');

// ── OIDC discovery ─────────────────────────────────────────────────────────
router.get('/.well-known/openid-configuration', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/api/auth/authorize`,
    token_endpoint: `${base}/api/auth/token`,
    revocation_endpoint: `${base}/api/auth/revoke`,
    jwks_uri: `${base}/api/auth/.well-known/jwks.json`,
    userinfo_endpoint: `${base}/api/user/getuser`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
  });
});

// ── JWKS ───────────────────────────────────────────────────────────────────
// Served both at the issuer root and under /auth so the advertised jwks_uri
// works when the request is proxied through the API Gateway.
function jwksHandler(req, res) {
  const { getJWKS } = require('../config/keys');
  res.json(getJWKS());
}
router.get('/auth/.well-known/jwks.json', jwksHandler);
router.get('/.well-known/jwks.json', jwksHandler);

// ─ OAuth 2.1 authorization endpoint ───────────────────────────────────────
// Direct-credential variant for first-party SPAs (returns a one-time code).
router.post('/auth/authorize', validateAuthorize, validateLogin, authController.authorizeWithCredentials);
// Consent/step-up variant for an already-authenticated principal.
router.get('/auth/authorize', validateAuthorize, authController.authorize);
// Registration → one-time code (no tokens).
router.post('/auth/register', uploadUserFile, validateAuthorize, validateRegister, authController.register);
// Role-specific registration (BUYER, SELLER, PROVIDER) → one-time code (no tokens).
router.post('/auth/register/:role', uploadUserFile, validateAuthorize, validateRoleRegistration, authController.registerWithRole);

// ── OAuth 2.1 token endpoint (the ONLY token issuer) ───────────────────────
router.post('/auth/token', authController.tokenExchange);
router.post('/auth/refresh', authController.refreshToken);
router.post('/auth/revoke', authController.revokeToken);

// ─ Resource endpoints ─────────────────────────────────────────────────────
router.get('/user/getuser', authenticate, authController.getCurrentUser);
router.post('/user/logout', authController.logoutUser);
// Multi-actor accounts choose which role the session acts as (see the
// account/role model in identity-service/src/models/Role.js).
router.post('/auth/switch-role', authenticate, authController.switchRole);
// Check role access status for portal authorization
router.get('/auth/role-status/:role', authenticate, authController.checkRoleAccessStatus);

module.exports = router;
