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

// Like intEnv, but a legitimate 0 is preserved (used for "disabled" switches such
// as an interval of 0) instead of collapsing onto the default.
function nonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

  // ── Onboarding lifecycle (abandoned-application sweep) ────────────────────
  // A seller/provider who registers but never finishes the store/vehicle wizard
  // is "abandoned". The sweep reclaims those memberships once they are this many
  // days old (a submitted application is never touched — it is under review).
  onboardingAbandonAfterDays: intEnv('ONBOARDING_ABANDON_AFTER_DAYS') || 30,
  // How often the background sweep runs. 0 disables the scheduler entirely;
  // the on-demand /internal/onboarding/cleanup route still works.
  onboardingCleanupIntervalMs: nonNegativeIntEnv('ONBOARDING_CLEANUP_INTERVAL_MS', 6 * 60 * 60 * 1000),
  // Run one pass shortly after boot (useful on a fresh deploy / in dev).
  onboardingCleanupRunOnStart: (process.env.ONBOARDING_CLEANUP_RUN_ON_START || 'true') !== 'false',
  // Also archive the (now empty) accounts whose abandoned membership was removed.
  // Off by default: dropping the membership is enough to unblock the email, and
  // locking accounts out is the operator's call.
  onboardingCleanupArchiveAccounts: (process.env.ONBOARDING_CLEANUP_ARCHIVE_ACCOUNTS || 'false') === 'true',
  // Max memberships reclaimed per pass (keeps one sweep from hogging the pool).
  onboardingCleanupBatchLimit: intEnv('ONBOARDING_CLEANUP_BATCH_LIMIT') || 500,

  cloudinaryName: process.env.CLOUDINARY_NAME,
  cloudinaryKey: process.env.CLOUDINARY_API_KEY,
  cloudinarySecret: process.env.CLOUDINARY_API_SECRET,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:8000',
};

module.exports = env;
