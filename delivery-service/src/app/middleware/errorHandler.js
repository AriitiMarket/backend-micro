const { AppError } = require('../../shared/errors');

function notFound(_req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found', errors: [] });
}

function normalizeError(err) {
  if (!err) return null;
  if (err.name === 'CastError') {
    return { status: 400, code: 'INVALID_ID', message: 'Invalid identifier' + (err.path ? ` for "${err.path}"` : '') };
  }
  if (err.name === 'ValidationError') {
    return {
      status: 400, code: 'VALIDATION_ERROR', message: 'Validation failed',
      errors: Object.values(err.errors || {}).map((e) => e.message),
    };
  }
  if (err.code === 11000) {
    const field = err.keyValue ? Object.keys(err.keyValue).join(', ') : '';
    return { status: 409, code: 'DUPLICATE_KEY', message: `Duplicate value${field ? ` for: ${field}` : ''}` };
  }
  if (err instanceof AppError) {
    return {
      status: err.status,
      code: err.code || 'APP_ERROR',
      message: err.message,
      errors: err.errors && err.errors.length ? err.errors : [],
    };
  }
  return null;
}

function errorHandler(err, _req, res, _next) {
  const normalized = normalizeError(err);
  const status = normalized ? normalized.status : (err.status || err.statusCode || 500);
  const code = normalized ? normalized.code : (err.code || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED'));
  const message = normalized
    ? normalized.message
    : (status >= 500 ? 'Internal server error' : (err.message || 'Request failed'));
  const details = normalized && normalized.errors ? normalized.errors : (err.errors || []);

  if (status >= 500) {
    console.error(`[delivery] Error ${status}:`, err.message);
  }

  res.status(status).json({ success: false, code, message, errors: details });
}

module.exports = { notFound, errorHandler, normalizeError, AppError };
