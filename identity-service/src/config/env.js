// Central environment loader for Identity Service.
require('dotenv').config();

const databaseUrl =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aritii_identity';

// node-postgres does NOT understand libpq's `connect_timeout` (seconds) or the
// Prisma-style `connection_limit` query param — pg-connection-string keeps them
// as inert string properties and `pg` never reads them. A DATABASE_URL such as
// `...?connect_timeout=30` therefore still used the pool's hard-coded timeout.
// We translate those params into the options `pg` actually honours; explicit
// DB_* environment variables always win over the URL.
const databaseUrlParams = (() => {
  try {
    return new URL(databaseUrl).searchParams;
  } catch (err) {
    return new URLSearchParams();
  }
})();

function intEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function intParam(name) {
  const raw = databaseUrlParams.get(name);
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const env = {
  port: parseInt(process.env.PORT, 10) || 8001,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl,

  // ── PostgreSQL pool & startup resilience ─────────────────────────────────
  // A cold boot (Docker Desktop spinning up, first-boot initdb, a busy disk) can
  // take far longer than the 5s this used to be hard-coded to, which surfaced as
  // a flood of "Connection terminated due to connection timeout" and aborted the
  // retry loop before PostgreSQL was reachable.
  dbConnectTimeoutMs: intEnv('DB_CONNECT_TIMEOUT_MS') || (intParam('connect_timeout') || 30) * 1000,
  dbPoolMax: intEnv('DB_POOL_MAX') || intParam('connection_limit') || 5,
  dbIdleTimeoutMs: intEnv('DB_IDLE_TIMEOUT_MS') || 30000,
  dbQueryTimeoutMs: intEnv('DB_QUERY_TIMEOUT_MS') || 30000,
  dbIdleInTransactionTimeoutMs: intEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS') || 30000,
  // Startup retry cadence (capped exponential backoff; retries never run out).
  dbConnectRetryDelayMs: intEnv('DB_CONNECT_RETRY_DELAY_MS') || 3000,
  dbConnectRetryMaxDelayMs: intEnv('DB_CONNECT_RETRY_MAX_DELAY_MS') || 15000,
  // Failed attempts between "still trying" summary lines (legacy name kept as a
  // fallback: DB_CONNECT_MAX_ATTEMPTS is a log cadence, not an attempt cap).
  dbConnectNoticeAttempts:
    intEnv('DB_CONNECT_NOTICE_ATTEMPTS') || intEnv('DB_CONNECT_MAX_ATTEMPTS') || 10,

  // ── OAuth 2.1 / OIDC settings ─────────────────────────────────────────────
  // Short-lived access tokens (default 10 minutes). Never issue long-lived
  // access tokens — refresh tokens (with rotation) carry the session.
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '10m',
  accessTokenExpiresInSec: parseInt(process.env.ACCESS_TOKEN_EXPIRES_IN_SEC, 10) || 600,
  refreshTokenExpiresInDays: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS, 10) || 30,
  authorizationCodeExpiresInSec: parseInt(process.env.AUTH_CODE_EXPIRES_IN_SEC, 10) || 300,
  issuer: process.env.ISSUER || 'aritii-identity',
  audience: process.env.AUDIENCE || 'aritii-market',
  // PKCE is mandatory and S256-only (OAuth 2.1). `plain` is rejected.
  pkceMethodsSupported: ['S256'],
  // OAuth clients allowed to start an authorization-code flow at this IdP.
  // Comma-separated. First-party SPAs are registered here.
  allowedClients: (process.env.OAUTH_CLIENTS || 'aritii-eshop,aritii-admin-web').split(',').map((c) => c.trim()).filter(Boolean),
  // Exact redirect URIs allowed per client prefix (web + native/loopback for dev).
  allowedRedirectUris: (process.env.OAUTH_REDIRECT_URIS || '').split(',').map((u) => u.trim()).filter(Boolean),

  // ─ Service-to-service authentication ─────────────────────────────────────
  // Dedicated shared secret for /internal/* routes. Deliberately NOT the JWT
  // signing secret — a leaked internal token must never be usable to mint tokens.
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || '',

  // Legacy HMAC secret — retained ONLY so old internal callers can be detected;
  // no new tokens are ever signed or verified with it.
  legacyJwtSecret: process.env.JWT_SECRET || '',

  cloudinaryName: process.env.CLOUDINARY_NAME,
  cloudinaryKey: process.env.CLOUDINARY_API_KEY,
  cloudinarySecret: process.env.CLOUDINARY_API_SECRET,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:8000',
};

module.exports = env;
