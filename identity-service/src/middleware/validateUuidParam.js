// Path-parameter validation: rejects a malformed UUID before it reaches the
// database.
//
// Why: user/entity ids are PostgreSQL `uuid` columns. Passing a non-UUID value
// straight through made PostgreSQL raise `invalid input syntax for type uuid`,
// which surfaced as a 500. A client mistake is a 400, never a server error.
const { fail } = require('../utils/response');

// Canonical 8-4-4-4-12 hexadecimal form (case-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} param - name of the route parameter to validate
 * @returns {import('express').RequestHandler}
 */
function validateUuidParam(param) {
  return function (req, res, next) {
    const value = req.params[param];
    if (!UUID_RE.test(String(value || ''))) {
      return fail(res, `Invalid ${param}: a UUID is required`, 400);
    }
    return next();
  };
}

module.exports = validateUuidParam;
module.exports.validateUuidParam = validateUuidParam;
module.exports.UUID_RE = UUID_RE;
