// Standard API response helpers.
//
// Shape is shared with the gateway and the other services:
//   { success: boolean, code?: string, message: string, errors: any[] }
// `fail` takes an optional `code` so every rejection carries a machine-readable
// reason, matching the `FORBIDDEN` / `NOT_FOUND` / `VALIDATION_ERROR` codes the
// gateway and commerce/delivery already emit.
function ok(res, data, message = '') {
  res.status(200).json({ success: true, message, ...data });
}

function created(res, data, message = '') {
  res.status(201).json({ success: true, message, ...data });
}

function fail(res, message = 'Something went wrong', status = 500, errors = [], code) {
  const body = { success: false, message, errors };
  if (code) body.code = code;
  res.status(status).json(body);
}

module.exports = { ok, created, fail };