function validateRequest(schema) {
  return (req, res, next) => {
    const errors = [];
    const target = schema.target === 'params' ? req.params : (schema.target === 'query' ? req.query : req.body);
    if (schema.required) {
      for (const field of schema.required) {
        if (target[field] === undefined || target[field] === null || target[field] === '') {
          errors.push(`${field} is required`);
        }
      }
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    return next();
  };
}

module.exports = { validateRequest };
