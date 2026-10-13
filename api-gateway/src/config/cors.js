const env = require('./env');

// CORS_ORIGIN may be a comma-separated list, or the literal '*' for wildcard.
const origins = env.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
const allowWildcard = origins.includes('*');

module.exports = {
  origin: (origin, callback) => {
    // Same-origin / non-browser callers send no Origin header.
    if (!origin) return callback(null, true);
    // Wildcard: allow all origins.
    if (allowWildcard) return callback(null, true);
    if (origins.includes(origin)) return callback(null, true);
    // Deny without throwing: a thrown Error surfaces as a 502 from the
    // gateway error handler instead of a normal CORS rejection.
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID'],
  // No cookies are used anywhere in this platform — so no credentialed CORS
  // and therefore no cross-site request-forgery surface.
  credentials: false,
};
