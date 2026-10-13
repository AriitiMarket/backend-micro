/**
 * Express middleware for request context
 */

const RequestContext = require('./context');
const Logger = require('./logger');

function contextMiddleware(serviceName) {
  const logger = new Logger(serviceName);

  return (req, res, next) => {
    const requestId = RequestContext.newRequestId();
    const traceId = req.headers['x-trace-id'] || RequestContext.newTraceId();

    RequestContext.setContext(requestId, {
      traceId,
      serviceName,
      userId: req.user?.id,
      method: req.method,
      path: req.path,
      ip: req.ip
    });

    // Attach to request
    req.requestId = requestId;
    req.traceId = traceId;
    req.logger = logger;

    // Log request
    logger.info(requestId, `${req.method} ${req.path}`);

    // Log response
    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = Date.now() - (RequestContext.getContext(requestId).startTime || Date.now());
      logger.info(requestId, 'Response', {
        statusCode: res.statusCode,
        duration
      });

      RequestContext.clearContext(requestId);
      originalEnd.apply(res, args);
    };

    next();
  };
}

module.exports = { contextMiddleware, RequestContext, Logger };
