/**
 * Internal service-to-service HTTP client.
 *
 * Canonical implementation for root monorepo package `@packages/service-client`.
 */
'use strict';

const http = require('http');
const https = require('https');

const {
  CALLER_HEADER,
  TOKEN_HEADER,
  loadCredentials,
  outboundCredentials,
  maskToken,
} = require('@packages/internal-auth');
const {
  TRACE_HEADER,
  normalizeTraceId,
  newTraceId,
  currentTraceId,
  logServiceCall,
  logError,
} = require('@packages/request-context');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 0;
const MAX_RETRIES_CEILING = 2;
const BASE_BACKOFF_MS = 120;
const MAX_BACKOFF_MS = 1500;
const DEFAULT_HEALTH_PATH = '/health/ready';
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];

/** Transport-level failure (nothing was learnt about the payload's fate). */
class ServiceCallError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'ServiceCallError';
    this.code = result.code;
    this.status = result.status;
    this.service = result.service;
    this.result = result;
  }
}

function clampRetries(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_RETRIES;
  return Math.min(parsed, MAX_RETRIES_CEILING);
}

/**
 * Platform-wide default timeout.
 */
function defaultTimeout() {
  const configured = parseInt(process.env.INTERNAL_CALL_TIMEOUT_MS, 10);
  return configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function buildUrl(baseUrl, requestPath, query) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(requestPath == null ? '' : requestPath);
  const url = new URL(base + '/' + suffix.replace(/^\/+/, ''));
  if (query && typeof query === 'object') {
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function backoffDelay(attempt) {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One HTTP round trip. Never rejects: the outcome is described in the result. */
function performCall(url, method, payload, headers, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      outcome.durationMs = Date.now() - startedAt;
      resolve(outcome);
    };

    let req;
    try {
      req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            if (raw) {
              try { body = JSON.parse(raw); } catch (_err) { body = { raw }; }
            }
            finish({ outcome: 'response', status: res.statusCode || 0, body, error: null });
          });
        }
      );
    } catch (err) {
      return finish({ outcome: 'transport_error', status: 0, body: null, error: err });
    }

    req.on('timeout', () => {
      req.destroy();
      finish({
        outcome: 'timeout',
        status: 0,
        body: null,
        error: new Error('Request timed out after ' + timeoutMs + 'ms'),
      });
    });

    req.on('error', (err) => {
      finish({ outcome: 'transport_error', status: 0, body: null, error: err });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function shouldRetry(outcome, status) {
  if (outcome === 'timeout' || outcome === 'transport_error') return true;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function resultCodeFor(outcome, status) {
  if (outcome === 'timeout') return 'SERVICE_TIMEOUT';
  if (outcome === 'transport_error') return 'SERVICE_UNAVAILABLE';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVICE_ERROR';
  return 'HTTP_' + status;
}

/**
 * Construct a client bound to one upstream service.
 */
function createInternalClient(config) {
  const opts = config || {};
  const name = String(opts.name || '').trim();
  const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : defaultTimeout();
  const maxRetries = clampRetries(opts.maxRetries);
  const credentials = opts.credentials || loadCredentials(process.env, name);

  if (!baseUrl) {
    logError('service_url_missing', {
      service: name,
      hint: 'set ' + (name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_SERVICE_URL'),
    });
  }

  const outbound = outboundCredentials(credentials);
  if (!outbound.token) {
    logError('service_credential_missing', {
      service: name,
      target: baseUrl,
      hint: 'set INTERNAL_SERVICE_TOKENS (or INTERNAL_SERVICE_TOKEN) and INTERNAL_SERVICE_NAME',
    });
  }

  async function request(method, requestPath, callOpts) {
    const call = callOpts || {};
    const upper = String(method || 'GET').toUpperCase();
    const traceId = normalizeTraceId(call.requestId || call.traceId)
      || currentTraceId()
      || newTraceId();
    const callTimeout = parseInt(call.timeoutMs, 10) > 0 ? parseInt(call.timeoutMs, 10) : timeoutMs;
    const budget = clampRetries(call.maxRetries === undefined ? maxRetries : call.maxRetries);
    const idempotent = IDEMPOTENT_METHODS.indexOf(upper) !== -1 || call.idempotent === true;
    const allowedRetries = idempotent ? budget : 0;

    const base = {
      service: name,
      target: baseUrl,
      method: upper,
      path: requestPath,
      requestId: traceId,
      credentialMasked: outbound.token ? maskToken(outbound.token) : null,
    };

    if (!outbound.token) {
      const missing = Object.assign({}, base, {
        ok: false, status: 0, body: null, code: 'NO_SERVICE_CREDENTIAL',
        error: 'No cluster credential configured for ' + (name || 'this service'),
        durationMs: 0, attempts: 0,
      });
      logServiceCall(missing);
      return missing;
    }

    let url;
    try {
      url = buildUrl(baseUrl, requestPath, call.query);
    } catch (err) {
      const invalid = Object.assign({}, base, {
        ok: false, status: 0, body: null, code: 'INVALID_SERVICE_URL',
        error: err.message, durationMs: 0, attempts: 0,
      });
      logServiceCall(invalid);
      return invalid;
    }

    const payload = call.body === undefined || call.body === null
      ? null
      : Buffer.from(JSON.stringify(call.body), 'utf8');

    const headers = {
      Accept: 'application/json',
      [TOKEN_HEADER]: outbound.token,
      [CALLER_HEADER]: outbound.service,
      [TRACE_HEADER]: traceId,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (call.headers && typeof call.headers === 'object') {
      for (const key of Object.keys(call.headers)) {
        if (call.headers[key] !== undefined) headers[key] = call.headers[key];
      }
    }

    let attempts = 0;
    let last = null;
    while (attempts <= allowedRetries) {
      attempts += 1;
      last = await performCall(url, upper, payload, headers, callTimeout);
      const succeeded = last.outcome === 'response' && last.status >= 200 && last.status < 300;
      if (!succeeded && attempts <= allowedRetries && shouldRetry(last.outcome, last.status)) {
        await sleep(backoffDelay(attempts));
        continue;
      }
      break;
    }

    const ok = last.outcome === 'response' && last.status >= 200 && last.status < 300;
    const result = Object.assign({}, base, {
      ok,
      status: last.outcome === 'response' ? last.status : 0,
      body: last.outcome === 'response' ? last.body : null,
      code: ok ? 'OK' : resultCodeFor(last.outcome, last.status),
      error: last.outcome === 'response'
        ? (ok ? null : 'HTTP ' + last.status)
        : (last.error ? last.error.message : 'request failed'),
      durationMs: last.durationMs,
      attempts,
    });
    logServiceCall(result);
    return result;
  }

  async function requestOrThrow(method, requestPath, opts) {
    const result = await request(method, requestPath, opts);
    if (result.status === 0 || (!result.ok && opts && opts.throwOnError)) {
      throw new ServiceCallError(
        result.error || ('Service call failed: ' + result.code),
        result
      );
    }
    return result;
  }

  async function health(probeTimeoutMs) {
    const parsed = parseInt(probeTimeoutMs, 10);
    const result = await request('GET', DEFAULT_HEALTH_PATH, {
      timeoutMs: parsed > 0 ? parsed : 2000,
      maxRetries: 0,
    });
    return { ok: result.ok, status: result.status, code: result.code, service: name };
  }

  return {
    name,
    baseUrl,
    timeoutMs,
    maxRetries,
    credentialMode: outbound.token ? (credentials.tokens[name] ? 'per-service' : 'shared') : 'none',
    request,
    requestOrThrow,
    health,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, Object.assign({}, opts, { body })),
    put: (path, body, opts) => request('PUT', path, Object.assign({}, opts, { body })),
    patch: (path, body, opts) => request('PATCH', path, Object.assign({}, opts, { body })),
    del: (path, opts) => request('DELETE', path, opts),
  };
}

module.exports = {
  createInternalClient,
  ServiceCallError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  MAX_RETRIES_CEILING,
  DEFAULT_HEALTH_PATH,
  buildUrl,
  shouldRetry,
  backoffDelay,
  defaultTimeout,
  IDEMPOTENT_METHODS,
};
