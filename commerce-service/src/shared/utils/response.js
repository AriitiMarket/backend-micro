// Response envelope helpers.
//
// `ok`/`created` spread `data` into the payload: `{ success, message, ...data }`.
// Two hazards come with that spread:
//
//  1. A Mongoose document spread as an object copies its INTERNAL cache
//     (`$__`, `activePaths`, `scope`, …) as plain own properties. `JSON.stringify`
//     then never gets the chance to call `doc.toJSON()`, so the client receives
//     the guts of the document. Documents are converted first.
//  2. An array has no keys to spread — `{ ...[a, b] }` becomes `{ 0: a, 1: b }`,
//     so a caller expecting `{ items: [...] }` silently reads `undefined`.
//     Arrays are wrapped under `data`.
//
// Plain objects pass through untouched: callers such as the admin settings
// client deliberately read their fields from the top level of the response.

function toEnvelope(data) {
  if (Array.isArray(data)) return { data };
  if (data && typeof data === 'object' && typeof data.toJSON === 'function' && data.$__) {
    return data.toJSON();
  }
  return data;
}

function ok(res, data, message = '') {
  res.status(200).json({ success: true, message, ...toEnvelope(data) });
}

function created(res, data, message = '') {
  res.status(201).json({ success: true, message, ...toEnvelope(data) });
}

module.exports = { ok, created, toEnvelope };
