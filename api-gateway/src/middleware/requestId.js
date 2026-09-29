// Request ID middleware — assigns a unique trace id (x-request-id) per request
// and propagates it via response header for end-to-end tracing and log correlation.
const crypto = require('crypto');

function requestId(req, res, next) {
  const existing = req.headers['x-request-id'];
  // Reuse a caller-provided id when present (e.g. from the frontend or a load balancer).
  const id = (existing && String(existing).trim()) || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
}

module.exports = requestId;