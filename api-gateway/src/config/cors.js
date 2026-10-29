// Central CORS configuration for the API Gateway.
// Controls allowed origins across all public HTTP endpoints and preflight OPTIONS.
const env = require('./env');

// CORS_ORIGIN may be a comma-separated list, or the literal '*' for wildcard.
const rawOrigin = env.corsOrigin || '*';
const origins = rawOrigin.split(',').map((o) => o.trim()).filter(Boolean);
const allowWildcard = origins.includes('*') || origins.length === 0;

module.exports = {
  /**
   * Evaluates incoming request origin against allowed origin rules.
   * Allows same-origin, configured domains, wildcard, and local development ports.
   * 
   * @param {string|undefined} origin - Origin header value sent by the browser
   * @param {function(Error|null, boolean=): void} callback - CORS evaluation callback
   */
  origin: (origin, callback) => {
    // Same-origin / non-browser callers send no Origin header.
    if (!origin) return callback(null, true);
    // Wildcard: allow all origins.
    if (allowWildcard) return callback(null, true);
    if (origins.includes(origin)) return callback(null, true);
    // Always allow local frontend dev and preview servers on any localhost / 127.0.0.1 port.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    // Deny without throwing: a thrown Error surfaces as a 502 from the
    // gateway error handler instead of a normal CORS rejection.
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // Omitting allowedHeaders allows any header requested in Access-Control-Request-Headers
  exposedHeaders: ['X-Request-ID'],
  // No cookies are used anywhere in this platform — so no credentialed CORS
  // and therefore no cross-site request-forgery surface.
  credentials: false,
};
