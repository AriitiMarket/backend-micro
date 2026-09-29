function notFound(req, res) {
  res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    errors: [],
  });
}

// Standardized downstream error mapping. The response keeps the frontend-compatible
// { success, message, errors } contract and additionally includes a stable `code`.
function errorHandler(err, req, res, next) {
  // Respect a status already chosen by contract/validation errors.
  const status = err.statusCode || 502;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = err.message || 'An unexpected error occurred';

  if (err.code === 'ECONNREFUSED') {
    code = 'SERVICE_UNAVAILABLE';
    message = 'Service temporarily unavailable';
  } else if (err.code === 'ETIMEDOUT' || status === 504) {
    code = 'SERVICE_TIMEOUT';
    message = 'Service request timed out';
  } else if (status === 429) {
    code = 'RATE_LIMIT_EXCEEDED';
  } else if (status === 401) {
    code = 'UNAUTHORIZED';
  } else if (status === 403) {
    code = 'FORBIDDEN';
  } else if (status === 404) {
    code = 'NOT_FOUND';
  } else if (status === 400) {
    code = 'VALIDATION_ERROR';
  }

  console.error('[gateway] error' + (req.id ? ' [' + req.id + ']' : '') + ':', err);
  res.status(status).json({
    success: false,
    code,
    message,
    errors: err.errors || [],
  });
}

module.exports = { notFound, errorHandler };
