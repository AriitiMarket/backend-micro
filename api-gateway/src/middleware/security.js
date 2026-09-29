// Transport + browser security headers.
//
// OAuth 2.1 requires TLS: in production every plaintext request is redirected to
// HTTPS (the TLS terminator sets x-forwarded-proto) and HSTS is emitted so
// browsers never fall back to http. Nothing here affects local development.
const env = require('../config/env');

const HSTS_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

function enforceHttps(req, res, next) {
  if (env.nodeEnv !== 'production') return next();

  // With `trust proxy` enabled, req.secure reflects x-forwarded-proto.
  if (req.secure || req.get('x-forwarded-proto') === 'https') return next();

  // Only redirect idempotent requests; never replay a request body to https.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const host = req.get('host') || '';
    return res.redirect(308, 'https://' + host + req.originalUrl);
  }

  return res.status(403).json({
    success: false,
    code: 'HTTPS_REQUIRED',
    message: 'HTTPS is required. Send this request over TLS.',
    errors: [],
  });
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (env.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=' + HSTS_MAX_AGE + '; includeSubDomains; preload');
  }
  return next();
}

module.exports = { enforceHttps, securityHeaders };
