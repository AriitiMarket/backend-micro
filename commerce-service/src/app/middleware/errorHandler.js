const { standardErrorHandler } = require('../../shared/middleware/standardErrorHandler');

function notFound(req, res, next) {
  res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: 'Route not found: ' + req.method + ' ' + req.originalUrl,
    errors: [],
  });
}

// Canonical error handler is standardErrorHandler in shared/middleware
module.exports = {
  notFound,
  errorHandler: standardErrorHandler,
};
