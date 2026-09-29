// Short-lived availability memory for downstream services.
//
// The gateway must not route traffic to a service that is not ready. A full
// circuit breaker is overkill here: what is needed is that an observed failure
// (connection refused/timeout, or a failed readiness probe) is *remembered* for
// a short window, so the gateway answers immediately with
// 503 + Retry-After instead of opening a doomed socket for every queued request.
//
// State is deliberately FAIL-OPEN: "unknown" means "try it". Only an observed
// failure marks a service down, and the mark expires on its own, so a recovered
// service is retried without external intervention — a stale negative can never
// take a healthy service out of rotation permanently.
'use strict';

const DOWN_TTL_MS = parseInt(process.env.GATEWAY_UNAVAILABLE_TTL_MS, 10) > 0
  ? parseInt(process.env.GATEWAY_UNAVAILABLE_TTL_MS, 10)
  : 2000;

const downUntil = new Map();
const lastFailure = new Map();

/** Record an observed failure for `service` (no-op for an unknown service). */
function markDown(service, reason) {
  if (!service) return;
  downUntil.set(service, Date.now() + DOWN_TTL_MS);
  lastFailure.set(service, { reason: reason || 'unavailable', at: new Date().toISOString() });
}

/** Clear the failure state — called whenever a call actually succeeds. */
function markUp(service) {
  if (!service) return;
  downUntil.delete(service);
  lastFailure.delete(service);
}

/** True while the service is inside its failure window. */
function isDown(service) {
  if (!service) return false;
  const until = downUntil.get(service);
  if (!until) return false;
  if (Date.now() >= until) {
    downUntil.delete(service);
    return false;
  }
  return true;
}

/** Diagnostic view for /health and tests. */
function snapshot() {
  const out = {};
  for (const service of lastFailure.keys()) {
    out[service] = {
      down: isDown(service),
      reason: lastFailure.get(service).reason,
      since: lastFailure.get(service).at,
    };
  }
  return out;
}

function reset() {
  downUntil.clear();
  lastFailure.clear();
}

module.exports = { markDown, markUp, isDown, snapshot, reset, DOWN_TTL_MS };
