/**
 * Service registry — the single source of truth for where peer services live.
 *
 * The gateway is the only component that talks to the backend services, and it
 * resolves each of them from an environment variable so that moving between
 * environments is a matter of configuration and never source:
 *
 *   local Docker (docker-compose.yml)  http://identity:8001
 *   CI                                 http://identity:8001 (compose network)
 *   staging / cloud                    https://identity.internal.<env>
 *
 * Nothing else in the codebase may hard-code a hostname, container name or
 * port.
 */
'use strict';

const { loadCredentials, describeCredentials } = require('../shared/internal-auth');

function cleanUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

const SELF = String(process.env.INTERNAL_SERVICE_NAME || 'gateway').trim().toLowerCase();

const services = {
  self: SELF,
  identity: {
    name: 'identity',
    url: cleanUrl(process.env.IDENTITY_SERVICE_URL) || 'http://localhost:8001',
  },
  commerce: {
    name: 'commerce',
    url: cleanUrl(process.env.COMMERCE_SERVICE_URL) || 'http://localhost:8002',
  },
  delivery: {
    name: 'delivery',
    url: cleanUrl(process.env.DELIVERY_SERVICE_URL) || 'http://localhost:8003',
  },
};

// One credential set for the whole process: the gateway signs every downstream
// request with its own per-service secret (falling back to the shared legacy
// token when the per-service map is not configured).
const credentials = loadCredentials(process.env, SELF);
const outbound = require('../shared/internal-auth').outboundCredentials(credentials);

// host:port -> canonical service name, so the proxy can attribute a failure to
// a service without the caller having to pass its name along.
const byAuthority = new Map();
for (const key of Object.keys(services)) {
  if (key === 'self') continue;
  try {
    const parsed = new URL(services[key].url);
    byAuthority.set(parsed.host.toLowerCase(), services[key].name);
  } catch (_err) { /* invalid URL: reported by describeServices() at boot */ }
}

/** Canonical service name owning an absolute URL, or null when unknown. */
function serviceNameForUrl(targetUrl) {
  try {
    return byAuthority.get(new URL(targetUrl).host.toLowerCase()) || null;
  } catch (_err) {
    return null;
  }
}

/** Startup log payload — proves which topology the process actually resolved. */
function describeServices() {
  const out = { self: services.self };
  for (const key of Object.keys(services)) {
    if (key === 'self') continue;
    out[key] = services[key].url;
  }
  return out;
}

module.exports = {
  services,
  credentials,
  outbound,
  serviceNameForUrl,
  describeServices,
  describeCredentials: () => describeCredentials(credentials),
};
