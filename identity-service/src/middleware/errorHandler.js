// Centralized error handler for Identity Service.
const { fail } = require('../utils/response');

function notFound(req, res) {
  return fail(res, 'Route not found', 404, [], 'ROUTE_NOT_FOUND');
}

function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  const message = err.message || 'Internal server error';
  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  }
  return fail(res, message, status, [], err.code);
}

module.exports = { notFound, errorHandler };
