/**
 * Cluster credential verification — the service-to-service trust boundary.
 *
 * ONE canonical implementation, kept byte-identical across `api-gateway`,
 * `identity-service`, `commerce-service` and `delivery-service` (the same
 * convention `middleware/authorize.js` already follows — this repo has no shared
 * workspace package, so identical copies are what make the boundary auditable
 * from a single file).
 *
 * Model
 * -----
 *   * Every request that crosses the trust boundary names its caller in
 *     `x-internal-service` and proves it with `x-internal-token`.
 *   * `INTERNAL_SERVICE_TOKENS` is a per-caller credential map
 *     ({"gateway":"…","identity":"…","commerce":"…","delivery":"…"}). A
 *     component only ever SENDS its own secret, so a leaked credential
 *     authorises exactly one caller identity instead of the whole cluster: a
 *     compromised Commerce can reach what Commerce may reach, and cannot
 *     impersonate Delivery or the Gateway.
 *   * A single shared `INTERNAL_SERVICE_TOKEN` is still honoured as a fallback,
 *     which keeps bare-metal development working. The containerised deployment
 *     in `docker-compose.yml` sets the per-service map instead.
 *
 * The credential is deliberately NOT the JWT signing key: a leaked cluster
 * credential can never mint or verify a user token.
 */
'use strict';

const crypto = require('crypto');

const CALLER_HEADER = 'x-internal-service';
const TOKEN_HEADER = 'x-internal-token';

// Canonical service names: the keys of the credential map, and the only values
// accepted in `x-internal-service`.
const SERVICE_NAMES = ['gateway', 'identity', 'commerce', 'delivery'];

// Long/legacy names normalised onto the canonical ones, so an already-deployed
// caller that still sends `x-internal-service: commerce-service` is understood.
const SERVICE_ALIASES = {
  'api-gateway': 'gateway',
  'identity-service': 'identity',
  'commerce-service': 'commerce',
  'delivery-service': 'delivery',
};

function canonicalServiceName(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  return SERVICE_ALIASES[raw] || raw;
}

function isKnownService(name) {
  return SERVICE_NAMES.indexOf(name) !== -1;
}

/** Constant-time comparison that never throws on a length mismatch. */
function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a), 'utf8');
  const right = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Parse the credential map. Accepts JSON ({"gateway":"s3cret"}) or the compact
 * `gateway:s3cret,delivery:s3cret` form. Anything unparseable yields an empty
 * map, which makes verification fail closed.
 */
function parseTokenMap(raw) {
  const tokens = Object.create(null);
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return tokens;

  let entries;
  if (text.charAt(0) === '{') {
    let parsed;
    try { parsed = JSON.parse(text); } catch (_err) { return tokens; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return tokens;
    entries = Object.entries(parsed);
  } else {
    entries = text
      .split(',')
      .map((part) => {
        const index = part.indexOf(':');
        return index === -1 ? null : [part.slice(0, index), part.slice(index + 1)];
      })
      .filter(Boolean);
  }

  for (const entry of entries) {
    const name = canonicalServiceName(entry[0]);
    const secret = String(entry[1] == null ? '' : entry[1]).trim();
    if (name && secret) tokens[name] = secret;
  }
  return tokens;
}

/**
 * Resolve the credential material for one component.
 * @param {object} source `process.env` (or a test double)
 * @param {string} selfName the component's own canonical service name
 */
function loadCredentials(source, selfName) {
  const env = source || {};
  return {
    self: canonicalServiceName(selfName || env.INTERNAL_SERVICE_NAME),
    tokens: parseTokenMap(env.INTERNAL_SERVICE_TOKENS),
    shared: String(env.INTERNAL_SERVICE_TOKEN || '').trim(),
    // Explicit opt-in that re-enables the legacy shared credential even when
    // per-service credentials are configured.
    allowShared: String(env.INTERNAL_ALLOW_SHARED_TOKEN || '').trim().toLowerCase() === 'true',
  };
}

/**
 * May the legacy single shared credential be accepted?
 *
 * NOT as soon as this component knows per-service credentials. Otherwise
 * anything that reaches a stale `.env` or an image with the old shared secret
 * baked in would silently bypass per-caller authorisation — the whole point of
 * the map. The shared token stays usable only where it is the ONLY credential
 * configured (bare-metal development), or where it is explicitly re-enabled.
 */
function sharedFallbackAllowed(credentials) {
  const creds = credentials || {};
  const hasPerServiceCredentials = Object.keys(creds.tokens || {}).length > 0;
  return hasPerServiceCredentials ? Boolean(creds.allowShared) : true;
}

/**
 * The credential this component PRESENTS to its peers: its own per-service
 * secret when configured, otherwise the shared legacy secret.
 */
function outboundCredentials(credentials) {
  const creds = credentials || {};
  const self = creds.self || '';
  const token = (self && creds.tokens[self]) || creds.shared || '';
  return { service: self || 'unknown', token };
}

function readHeader(source, name) {
  if (!source) return '';
  if (typeof source.get === 'function') {
    try { return String(source.get(name) || ''); } catch (_err) { /* fall through */ }
  }
  const headers = source.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

function refuse(message) {
  return { ok: false, caller: '', shared: false, status: 403, code: 'FORBIDDEN', message: message };
}

/**
 * Verify an inbound service-to-service request.
 *
 * Fails closed: an unidentified caller, an unknown caller name, or a token that
 * does not belong to the caller it claims to be is rejected.
 *
 * @returns {{ok: boolean, caller: string, shared: boolean, status: number, code: string, message: string}}
 */
function verifyInternalRequest(source, credentials) {
  const creds = credentials || loadCredentials(process.env, '');
  const caller = canonicalServiceName(readHeader(source, CALLER_HEADER));
  const token = readHeader(source, TOKEN_HEADER);

  if (!caller) {
    return refuse('Caller not identified: ' + CALLER_HEADER + ' is required');
  }
  if (!isKnownService(caller)) {
    return refuse('Unknown calling service: ' + caller);
  }
  if (creds.tokens[caller] && timingSafeEqual(token, creds.tokens[caller])) {
    return { ok: true, caller, shared: false, status: 200, code: 'OK', message: 'ok' };
  }
  if (creds.shared && sharedFallbackAllowed(creds) && timingSafeEqual(token, creds.shared)) {
    // Legacy shared-credential mode: the caller is identified but not
    // individually authenticated, so it is flagged for auditability.
    return { ok: true, caller, shared: true, status: 200, code: 'OK', message: 'ok' };
  }
  return refuse('Invalid service credential');
}

/** Never log a credential — only enough to tell two of them apart. */
function maskToken(token) {
  const value = String(token == null ? '' : token);
  if (!value) return '<unset>';
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '...' + value.slice(-2) + ' (' + value.length + ' chars)';
}

/** Startup log payload: which credentials are usable, without revealing them. */
function describeCredentials(credentials) {
  const creds = credentials || {};
  const outbound = outboundCredentials(creds);
  return {
    service: creds.self || '<unset>',
    credentialMode: outbound.token ? (creds.tokens[creds.self] ? 'per-service' : 'shared') : 'none',
    credentialLength: outbound.token.length,
    acceptedCallers: Object.keys(creds.tokens || {}).sort(),
    sharedFallback: sharedFallbackAllowed(creds),
  };
}

module.exports = {
  CALLER_HEADER,
  TOKEN_HEADER,
  SERVICE_NAMES,
  canonicalServiceName,
  isKnownService,
  timingSafeEqual,
  parseTokenMap,
  loadCredentials,
  sharedFallbackAllowed,
  outboundCredentials,
  verifyInternalRequest,
  maskToken,
  describeCredentials,
};
