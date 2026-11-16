/**
 * @packages/request-context - Main Entry Point
 */
'use strict';

const requestContextCanonical = require('./request-context');
const RequestContext = require('./context');
const Logger = require('./logger');
const { contextMiddleware } = require('./middleware');

module.exports = {
  // Canonical tracing & structured logging functions
  ...requestContextCanonical,

  // Legacy/Context class & middleware
  RequestContext,
  Logger,
  contextMiddleware,

  // Shortcuts
  newRequestId: () => RequestContext.newRequestId(),
  setContext: (reqId, context) => RequestContext.setContext(reqId, context),
  getContext: (reqId) => RequestContext.getContext(reqId),
  getTraceId: (reqId) => RequestContext.getTraceId(reqId),
};
