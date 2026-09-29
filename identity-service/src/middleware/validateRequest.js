// Request validation middleware — runs a provided validator against req fields.
function validateRequest(validator) {
  return function (req, res, next) {
    const result = validator.validate(req.body);
    if (result.error) {
      const err = new Error(result.error.details.map(function (d) {
        return d.message;
      }).join(', '));
      err.statusCode = 400;
      return next(err);
    }
    return next();
  };
}

module.exports = validateRequest;
