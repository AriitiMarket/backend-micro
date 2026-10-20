require('dotenv').config();

// The service registry is the single source of truth for downstream URLs; env
// only re-exports it under the historical names so existing call sites and
// operators keep working.
const { services } = require('./services');

module.exports = {
  port: parseInt(process.env.PORT, 10) || 8000,
  nodeEnv: process.env.NODE_ENV || 'development',
  identityServiceUrl: services.identity.url,
  commerceServiceUrl: services.commerce.url,
  deliveryServiceUrl: services.delivery.url,
  // Local Vite/dev servers commonly use 3001 or 5173 while the gateway is on
  // 3000. Keep the same allowlist for REST and Socket.io.
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001,http://localhost:5173',

  // Readiness probe budget for a single downstream service.
  healthProbeTimeoutMs: parseInt(process.env.GATEWAY_HEALTH_TIMEOUT_MS, 10) || 3000,

  // Expected JWT claims (must match Identity Service ISSUER/AUDIENCE). Used to
  // reject ID tokens / foreign tokens accepted as Bearer access tokens.
  issuer: process.env.ISSUER || 'aritii-identity',
  audience: process.env.AUDIENCE || 'aritii-market',

  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 10000,
  rateLimitAuthMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS, 10) || 20000,
  authRateLimitMax: parseInt(process.env.RATE_LIMIT_AUTH_ENDPOINT_MAX, 10) || 100,

  // Downstream proxy timeout (ms)
  proxyTimeoutMs: parseInt(process.env.GATEWAY_PROXY_TIMEOUT_MS, 10) || 30000,

  // Maximum buffered request body (bytes) accepted by the proxy.
  maxBodyBytes: parseInt(process.env.GATEWAY_MAX_BODY_BYTES, 10) || 12 * 1024 * 1024,
};
