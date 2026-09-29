// Realtime client — reports Product Request mutations to the API Gateway's
// internal socket fan-out (`POST /internal/realtime/emit`).
//
// The gateway is the ONE peer a service still calls on its own address, and for a
// concrete architectural reason: the gateway owns the Socket.IO server and the
// per-user rooms, so it is the only process that can push to a connected client.
// Every other inter-service call goes directly to the service that owns the
// data. (The hop is signed like any other internal call: caller `commerce`, with
// commerce's own credential.)
//
// Deliberately fire-and-forget with a short timeout: realtime is a nicety on top
// of REST, so a down/slow gateway must never fail or delay a user action. The
// gateway validates the shape and pushes `request:event` to the buyer's and
// seller's user-rooms plus the per-request room.
const { createInternalClient } = require('../internal-client');
const { services } = require('../../app/config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.gateway.url,
  timeoutMs: parseInt(process.env.REALTIME_CALL_TIMEOUT_MS, 10) || 3000,
  maxRetries: 0, // a dropped realtime ping is never worth a retry
});

async function emitRequestEvent({ type, requestId, recipients = [], actorId = null, data = {} }) {
  if (!type || !requestId) return null;

  // Never throws: the internal client returns a result (and logs the outcome),
  // so a gateway that is down or slow cannot break the caller's request.
  await client.request('POST', '/internal/realtime/emit', {
    body: {
      type,
      requestId: String(requestId),
      recipients: (Array.isArray(recipients) ? recipients : []).map(String).slice(0, 10),
      actorId: actorId ? String(actorId) : null,
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
    },
  });
  return null;
}

module.exports = { emitRequestEvent, realtimeClientInternals: client };
