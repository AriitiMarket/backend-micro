/**
 * @aritii/request-context - Main Entry Point
 */

const RequestContext = require('./context');
const Logger = require('./logger');
const { contextMiddleware } = require('./middleware');

module.exports = {
  RequestContext,
  Logger,
  contextMiddleware,
  
  // Shortcuts
  newTraceId: () => RequestContext.newTraceId(),
  newRequestId: () => RequestContext.newRequestId(),
  setContext: (requestId, context) => RequestContext.setContext(requestId, context),
  getContext: (requestId) => RequestContext.getContext(requestId),
  getTraceId: (requestId) => RequestContext.getTraceId(requestId)
};
