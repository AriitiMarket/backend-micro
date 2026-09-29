function validateRequest(schema) {
  return (req, res, next) => {
    if (!schema) return next();
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const details = error.details.map((d) => d.message);
      return res.status(400).json({ success: false, message: 'Validation failed', errors: details });
    }
    req.body = value;
    return next();
  };
}

module.exports = validateRequest;
