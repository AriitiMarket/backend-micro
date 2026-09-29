function notFound(req, res, next) {
  res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: 'Route not found: ' + req.method + ' ' + req.originalUrl,
    errors: [],
  });
}

// Maps driver/validation errors onto client errors. Without this an invalid
// `:id` (e.g. the literal "undefined" from a stale link) reaches Mongoose and
// surfaces as a 500 CastError — leaking internals and making a bad request look
// like a server fault.
function normalizeError(err) {
  if (!err) return null;
  if (err.name === 'CastError') {
    return {
      status: 400,
      code: 'INVALID_ID',
      message: 'Invalid identifier' + (err.path ? ' for "' + err.path + '"' : ''),
    };
  }
  if (err.name === 'ValidationError') {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      errors: Object.values(err.errors || {}).map((e) => e.message),
    };
  }
  if (err.code === 11000) {
    return { status: 409, code: 'DUPLICATE_KEY', message: 'Duplicate value' };
  }
  return null;
}

function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err);
  const status = normalized ? normalized.status : (err.statusCode || err.status || 500);
  const code = normalized ? normalized.code : (err.code || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED'));
  // Never echo internal failure details to the client; log them instead.
  const message = normalized
    ? normalized.message
    : (status >= 500 ? 'Internal Server Error' : (err.message || 'Request failed'));
  const details = normalized && normalized.errors ? normalized.errors : (err.errors || []);

  if (status >= 500) console.error('[commerce]', err);
  res.status(status).json({ success: false, code, message, errors: details });
}

module.exports = { notFound, errorHandler, normalizeError };
