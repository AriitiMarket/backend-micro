/**
 * Unified logging with request context
 */

const RequestContext = require('./context');

class Logger {
  constructor(serviceName) {
    this.serviceName = serviceName;
  }

  /**
   * Log info
   */
  info(requestId, message, data = {}) {
    const log = RequestContext.formatLog(requestId, 'INFO', message, data);
    console.log(JSON.stringify(log));
  }

  /**
   * Log warning
   */
  warn(requestId, message, data = {}) {
    const log = RequestContext.formatLog(requestId, 'WARN', message, data);
    console.warn(JSON.stringify(log));
  }

  /**
   * Log error
   */
  error(requestId, message, error, data = {}) {
    const log = RequestContext.formatLog(requestId, 'ERROR', message, {
      error: error.message,
      stack: error.stack,
      ...data
    });
    console.error(JSON.stringify(log));
  }

  /**
   * Log service call
   */
  serviceCall(requestId, serviceName, method, endpoint, duration, statusCode) {
    const log = RequestContext.formatLog(requestId, 'SERVICE_CALL', 
      `Called ${serviceName}`, 
      {
        serviceName,
        method,
        endpoint,
        duration,
        statusCode
      }
    );
    console.log(JSON.stringify(log));
  }

  /**
   * Log database operation
   */
  database(requestId, operation, collection, duration, result) {
    const log = RequestContext.formatLog(requestId, 'DATABASE',
      `Database ${operation}`,
      {
        operation,
        collection,
        duration,
        rowsAffected: result?.modifiedCount || result?.deletedCount || 0
      }
    );
    console.log(JSON.stringify(log));
  }
}

module.exports = Logger;
