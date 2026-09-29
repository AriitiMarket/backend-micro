/**
 * Service registry — the single source of truth for where peer services live.
 *
 * Every outbound service-to-service call in this process resolves its target
 * from here, so moving between environments is a matter of changing environment
 * variables and never source:
 *
 *   local Docker (docker-compose.yml)  http://identity:8001
 *   CI                                 http://identity:8001 (compose network)
 *   staging / cloud                    https://identity.internal.<env>
 *
 * Nothing else in the codebase may hard-code a hostname, container name or
 * port. `IDENTITY_SERVICE_URL` wins; the legacy `IDENTITY_SERVICE_HOST` /
 * `IDENTITY_SERVICE_PORT` pair is derived for backwards compatibility, and a
 * localhost default keeps bare-metal development working.
 */
'use strict';

function cleanUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

/**
 * Resolve one peer's base URL.
 *
 * @param {object} spec
 * @param {string} spec.urlVar   e.g. 'COMMERCE_SERVICE_URL'
 * @param {string} [spec.hostVar] legacy host variable, e.g. 'COMMERCE_SERVICE_HOST'
 * @param {string} [spec.portVar] legacy port variable
 * @param {string} [spec.port]    port used with the legacy variables
 * @param {string} spec.fallback  bare-metal development default
 */
function resolveServiceUrl(spec) {
  const direct = cleanUrl(process.env[spec.urlVar]);
  if (direct) return direct;

  const host = String((spec.hostVar && process.env[spec.hostVar]) || '').trim();
  if (host) {
    const port = String((spec.portVar && process.env[spec.portVar]) || spec.port || '').trim();
    return cleanUrl(port ? 'http://' + host + ':' + port : 'http://' + host);
  }

  return cleanUrl(spec.fallback);
}

const SELF = String(process.env.INTERNAL_SERVICE_NAME || 'delivery').trim().toLowerCase();

const services = {
  self: SELF,

  // The gateway is NOT used to reach peers (that would re-enter the public
  // edge and add a hop). It is kept in the registry only for the endpoints it
  // genuinely owns — the Socket.IO fan-out (`/internal/realtime/emit`).
  gateway: {
    name: 'gateway',
    url: resolveServiceUrl({
      urlVar: 'GATEWAY_URL',
      hostVar: 'API_GATEWAY_HOST',
      portVar: 'API_GATEWAY_PORT',
      port: '8000',
      fallback: cleanUrl(process.env.API_GATEWAY_URL) || 'http://localhost:8000',
    }),
  },

  identity: {
    name: 'identity',
    url: resolveServiceUrl({
      urlVar: 'IDENTITY_SERVICE_URL',
      hostVar: 'IDENTITY_SERVICE_HOST',
      portVar: 'IDENTITY_SERVICE_PORT',
      port: '8001',
      fallback: 'http://localhost:8001',
    }),
  },

  commerce: {
    name: 'commerce',
    url: resolveServiceUrl({
      urlVar: 'COMMERCE_SERVICE_URL',
      hostVar: 'COMMERCE_SERVICE_HOST',
      portVar: 'COMMERCE_SERVICE_PORT',
      port: '8002',
      fallback: 'http://localhost:8002',
    }),
  },
};

/** Startup log payload — proves which topology the process actually resolved. */
function describeServices() {
  const out = { self: services.self };
  for (const key of Object.keys(services)) {
    if (key === 'self') continue;
    out[key] = services[key].url;
  }
  return out;
}

module.exports = { services, resolveServiceUrl, describeServices };
