// Internal realtime ingest: `POST /internal/realtime/emit`.
//
// Commerce-service reports request-domain mutations here (cluster credential
// only, never a browser). The gateway fans the event out over Socket.io to the
// two participant user-rooms plus the per-request room, so a client only ever
// receives events for requests it belongs to.
//
// Contract (kept deliberately small so the UI stays "signal, then refetch"):
//   {
//     type:      'request.<domain>.<verb>',   // e.g. request.message.created
//     requestId: string,                      // Mongo id
//     recipients:[userId, userId],            // buyer + seller
//     actorId:   userId | null,               // who caused it (no self-toasts)
//     data:      { ... }                      // message / list card / status
//   }
const registry = require('./registry');

const MAX_BODY_BYTES = 256 * 1024;
// `request.created` (one segment) and `request.message.created` (two) are both valid.
const TYPE_PATTERN = /^request\.[a-z_]+(?:\.[a-z_]+)*$/;
const ID_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function invalid(res, message) {
  return res.status(400).json({
    success: false,
    code: 'INVALID_EVENT',
    message,
    errors: [],
  });
}

async function emitRequestEvent(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err.statusCode === 413) {
      return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: err.message, errors: [] });
    }
    return invalid(res, 'Body must be valid JSON');
  }

  const type = typeof payload.type === 'string' ? payload.type : '';
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  if (!TYPE_PATTERN.test(type)) return invalid(res, 'type must look like "request.<domain>.<verb>"');
  if (!ID_PATTERN.test(requestId)) return invalid(res, 'requestId is missing or malformed');

  const recipients = (Array.isArray(payload.recipients) ? payload.recipients : [])
    .filter((value) => typeof value === 'string' && ID_PATTERN.test(value))
    .slice(0, 10);
  const actorId = typeof payload.actorId === 'string' && ID_PATTERN.test(payload.actorId) ? payload.actorId : null;
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};

  const io = registry.getIo();
  if (!io) {
    return res.status(503).json({
      success: false,
      code: 'REALTIME_UNAVAILABLE',
      message: 'Socket layer is not attached yet',
      errors: [],
    });
  }

  const event = { type, requestId, actorId, data, at: new Date().toISOString() };

  // Room per request (explicit subscription) + one room per participant.
  // `io.to([...])` broadcasts to the UNION of the rooms, so a socket that is
  // in both (it always is) still receives exactly one copy per event.
  const rooms = recipients.map((userId) => `user:${userId}`);
  rooms.push(`request:${requestId}`);
  if (rooms.length) io.to(rooms).emit('request:event', event);

  return res.status(200).json({ success: true, code: 'EMITTED', rooms: rooms.length, recipients });
}

module.exports = { emitRequestEvent };
