/**
 * Standard Error Response Format and 404 Handler
 * Unified Express error middleware for commerce-service
 */
'use strict';

class ApiError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Map HTTP status to error code
 */
function getCodeForStatus(statusCode) {
  const statusMap = {
    400: 'VALIDATION_ERROR',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_SERVER_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
  };

  return statusMap[statusCode] || 'ERROR';
}

/**
 * Error response formatter
 */
function formatErrorResponse(err) {
  const statusCode = err.statusCode || 500;
  const code = err.code || getCodeForStatus(statusCode);

  const response = {
    success: false,
    error: err.message || 'An unexpected error occurred',
    code,
    timestamp: new Date().toISOString(),
  };

  if (err.details) {
    response.details = err.details;
  }

  if (err.errors && Array.isArray(err.errors)) {
    response.errors = err.errors;
  }

  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  return { statusCode, response };
}

/**
 * Express error middleware
 */
function standardErrorHandler(err, req, res, next) {
  // Convert Mongoose validation errors
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));

    const { statusCode, response } = formatErrorResponse(
      new ApiError('Validation failed', 400, 'VALIDATION_ERROR', { fields: errors })
    );
    return res.status(statusCode).json(response);
  }

  // Convert Mongoose cast errors
  if (err.name === 'CastError') {
    const { statusCode, response } = formatErrorResponse(
      new ApiError('Invalid ID format', 400, 'INVALID_ID')
    );
    return res.status(statusCode).json(response);
  }

  // Convert Mongoose duplicate key errors
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0];
    const { statusCode, response } = formatErrorResponse(
      new ApiError(`${field} already exists`, 409, 'DUPLICATE_ENTRY', { field })
    );
    return res.status(statusCode).json(response);
  }

  // Custom API errors
  if (err instanceof ApiError) {
    const { statusCode, response } = formatErrorResponse(err);
    return res.status(statusCode).json(response);
  }

  // Multer upload errors
  if (err && err.name === 'MulterError') {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    const status = tooLarge ? 413 : 400;
    const message = tooLarge
      ? 'File too large: the maximum size is 5MB'
      : `Upload failed: ${err.message || err.code}`;
    const { response } = formatErrorResponse(
      new ApiError(message, status, tooLarge ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR')
    );
    return res.status(status).json(response);
  }

  // Generic errors
  const { statusCode, response } = formatErrorResponse(
    new ApiError(
      err.message || 'Internal server error',
      err.statusCode || 500,
      err.code || 'INTERNAL_SERVER_ERROR'
    )
  );
  return res.status(statusCode).json(response);
}

function notFound(req, res, next) {
  res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: 'Route not found: ' + req.method + ' ' + req.originalUrl,
    errors: [],
  });
}

module.exports = {
  notFound,
  errorHandler: standardErrorHandler,
  standardErrorHandler,
  ApiError,
  formatErrorResponse,
  getCodeForStatus,
};
