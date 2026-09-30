// Canonical error types for the Delivery service.
//
// Every throw from the domain/service layer uses these so responses are
// consistent: `{ success, code, message, errors }` with the right HTTP status.
// The error handler (`app/middleware/errorHandler.js`) recognizes `AppError`
// and never leaks stack traces, database details or internal exceptions.
class AppError extends Error {
  constructor(message, status = 500, code = null, errors = []) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.errors = Array.isArray(errors) ? errors : [errors];
  }
}

function validationError(errors, message = 'Validation failed', code = 'VALIDATION_ERROR') {
  return new AppError(message, 400, code, errors);
}

function badRequest(message, code = 'BAD_REQUEST', errors = []) {
  return new AppError(message, 400, code, errors);
}

function notFound(message = 'Not found', code = 'NOT_FOUND') {
  return new AppError(message, 404, code);
}

function conflict(message, code = 'CONFLICT', errors = []) {
  return new AppError(message, 409, code, errors);
}

function forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
  return new AppError(message, 403, code);
}

function unauthorized(message = 'Unauthorized: missing identity', code = 'UNAUTHORIZED') {
  return new AppError(message, 401, code);
}

module.exports = { AppError, validationError, badRequest, notFound, conflict, forbidden, unauthorized };
