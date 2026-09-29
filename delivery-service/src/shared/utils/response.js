function ok(res, data, message = '') {
  res.status(200).json({ success: true, message, ...data });
}

function created(res, data, message = '') {
  res.status(201).json({ success: true, message, ...data });
}

function fail(res, status, message, errors = []) {
  res.status(status).json({ success: false, message, errors });
}

module.exports = { ok, created, fail };
