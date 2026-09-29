/**
 * Request tracing and structured logging for the backend services.
 *
 * ONE canonical implementation, kept byte-identical across `identity-service`,
 * `commerce-service` and `delivery-service`.
 *
 * The gateway assigns a trace id (`x-request-id`) at the edge and this
 * middleware repeats the contract inside each service: reuse a well-formed
 * inbound id, otherwise mint one, always echo it on the response, and expose it
 * as `req.id` / `req.traceId` so every log line and every outbound
 * service-to-service call can be correlated with the originating user request.
 */
'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const TRACE_HEADER = 'x-request-id';
const CORRELATION_HEADER = 'x-correlation-id';

// Carries the trace id of the request being handled through every async hop, so
// an outbound service-to-service call made deep inside a service chain is still
// attributed to the user request that triggered it — without threading a
// request object through every service and repository signature.
const traceStorage = new AsyncLocalStorage();

// Conservative shape: a trace id ends up in log lines and in outbound headers,
// so anything surprising is discarded rather than propagated (log-forging and
// header-injection defence).
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function normalizeTraceId(value) {
  const raw = String(value == null ? '' : value).trim();
  return TRACE_ID_PATTERN.test(raw) ? raw : '';
}

function newTraceId() {
  return crypto.randomUUID();
}

/** Express middleware: assigns/propagates the trace id. */
function requestId(req, res, next) {
  const inbound = normalizeTraceId(req.headers[TRACE_HEADER])
    || normalizeTraceId(req.headers[CORRELATION_HEADER]);
  const id = inbound || newTraceId();
  req.id = id;
  req.traceId = id;
  try { res.setHeader('X-Request-ID', id); } catch (_err) { /* headers already sent */ }
  // Everything the handler triggers — including outbound service calls — runs
  // inside this context.
  return traceStorage.run({ traceId: id }, next);
}

/** Trace id of the request currently being handled ('' outside a request). */
function currentTraceId() {
  const store = traceStorage.getStore();
  return store && store.traceId ? store.traceId : '';
}

/**
 * Emit one structured (JSON-lines) log record. Kept dependency-free so every
 * service emits the same shape and a log shipper needs no per-service parsing.
 */
function writeLog(level, event, fields) {
  const record = Object.assign({}, fields, {
    ts: new Date().toISOString(),
    level,
    event,
  });
  let line;
  try {
    line = JSON.stringify(record, (key, value) => (value === undefined ? undefined : value));
  } catch (_err) {
    line = JSON.stringify({ ts: record.ts, level, event, logError: 'unserializable fields' });
  }
  const stream = level === 'error' ? process.stderr : process.stdout;
  try { stream.write(line + '\n'); } catch (_err) { /* stream closed */ }
}

function logInfo(event, fields) { writeLog('info', event, fields); }
function logWarn(event, fields) { writeLog('warn', event, fields); }
function logError(event, fields) { writeLog('error', event, fields); }

/**
 * Log one service-to-service call OUTCOME. Never includes the credential.
 *
 * @param {object} entry {service, method, path, status, ok, durationMs, attempts, requestId, code, error}
 */
function logServiceCall(entry) {
  const call = entry || {};
  const level = call.ok ? 'info' : 'warn';
  writeLog(level, 'service_call', {
    direction: 'outbound',
    service: call.service,
    method: call.method,
    path: call.path,
    status: call.status,
    ok: Boolean(call.ok),
    durationMs: call.durationMs,
    attempts: call.attempts,
    requestId: call.requestId,
    code: call.code,
    error: call.error,
  });
}

module.exports = {
  TRACE_HEADER,
  CORRELATION_HEADER,
  normalizeTraceId,
  newTraceId,
  requestId,
  currentTraceId,
  logInfo,
  logWarn,
  logError,
  logServiceCall,
};
