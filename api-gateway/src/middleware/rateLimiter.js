// Rate limiting keyed on the verified JWT subject (set by middleware/identify).
//
// There are no cookies anywhere in this architecture, so the limiter never looks
// at them: buckets are either per-authenticated-user (higher ceiling) or
// per-source-IP (lower ceiling) for anonymous traffic.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');

function ipKey(req) {
  // Real client IP, normalised for IPv6 (ipKeyGenerator). A raw client-supplied
  // X-Forwarded-For header is never trusted directly.
  return ipKeyGenerator(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// Global API limiter — authenticated callers get the higher ceiling.
const apiLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  max: (req) => (req.identity && req.identity.id ? env.rateLimitAuthMax : env.rateLimitMax),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.', errors: [] },
  keyGenerator: (req) => (req.identity && req.identity.id ? 'user:' + req.identity.id : ipKey(req)),
});

// Strict limiter for credential/token endpoints. One instance whose key embeds
// the endpoint path, so each auth endpoint gets its own bucket: brute-force
// abuse of one endpoint cannot lock out a different legitimate action.
const authLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  max: env.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many authentication attempts, please try again later.', errors: [] },
  keyGenerator: (req) => {
    const endpoint = (req.originalUrl || req.baseUrl || req.path || '/').split('?')[0];
    return endpoint + ':' + ipKey(req);
  },
});

module.exports = { apiLimiter, authLimiter };
