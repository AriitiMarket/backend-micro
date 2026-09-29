// Downstream service health probe (http module only — no extra dependencies).
//
// Two distinct signals, because Docker and an orchestrator need to tell them
// apart:
//
//   * LIVENESS  (`/health/live`)  — is the process up? Restart it if not.
//   * READINESS (`/health/ready`) — can it serve traffic (database reachable)?
//                                   Take it out of rotation if not.
//
// The gateway probes readiness (a pod that is alive but has no database would
// fail every request anyway) and feeds the result into the availability
// tracker, so a service that is not ready is never routed to.
'use strict';

const http = require('http');
const availability = require('./serviceAvailability');

const READY_PATH = '/health/ready';
const LIVE_PATH = '/health/live';

function probe(baseUrl, path, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (_err) {
      return resolve({ reachable: false, statusCode: 0, error: 'invalid url' });
    }
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ reachable: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
      }
    );
    req.on('error', () => resolve({ reachable: false, statusCode: 0, error: 'unreachable' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, statusCode: 0, error: 'timeout' });
    });
  });
}

/**
 * Readiness probe for one service.
 * @param {string} baseUrl       e.g. https://identity.internal.example
 * @param {number} [timeoutMs]
 * @param {string} [serviceName] when given, the result updates the availability tracker
 */
async function checkHealth(baseUrl, timeoutMs = 3000, serviceName = null) {
  const result = await probe(baseUrl, READY_PATH, timeoutMs);
  const ready = result.reachable && result.statusCode === 200;
  if (serviceName) {
    if (ready) availability.markUp(serviceName);
    else availability.markDown(serviceName, result.error || 'status ' + result.statusCode);
  }
  return Object.assign({ ready }, result);
}

/** Liveness probe for one service. */
function checkLiveness(baseUrl, timeoutMs = 3000) {
  return probe(baseUrl, LIVE_PATH, timeoutMs);
}

/** Readiness probe for a whole registry (`{ name, url }` entries). */
async function checkAll(entries, timeoutMs = 3000) {
  const list = Array.isArray(entries) ? entries : [];
  const results = await Promise.all(
    list.map((entry) => checkHealth(entry.url, timeoutMs, entry.name))
  );
  const services = {};
  let ready = true;
  list.forEach((entry, index) => {
    services[entry.name] = results[index];
    if (!results[index].ready) ready = false;
  });
  return { ready, services };
}

module.exports = { checkHealth, checkLiveness, checkAll, READY_PATH, LIVE_PATH };
