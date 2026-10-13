/**
 * Gap 7: Validator Patterns - Shared Validation Library
 * Unified validation across all services
 */

class ValidationRegistry {
  constructor() {
    this.schemas = new Map();
    this.validators = new Map();
  }

  /**
   * Register validation schema
   */
  registerSchema(name, schema) {
    this.schemas.set(name, schema);
  }

  /**
   * Register custom validator
   */
  registerValidator(name, validator) {
    this.validators.set(name, validator);
  }

  /**
   * Get schema
   */
  getSchema(name) {
    return this.schemas.get(name);
  }

  /**
   * Validate against schema
   */
  validate(schemaName, data) {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      throw new Error(`Schema not found: ${schemaName}`);
    }
    return schema.validate(data);
  }

  /**
   * Middleware for route validation
   */
  validateRequest(schemaName, source = 'body') {
    return (req, res, next) => {
      try {
        const data = req[source];
        const { error, value } = this.validate(schemaName, data);

        if (error) {
          return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: error.details.map(e => ({
              field: e.path.join('.'),
              message: e.message
            }))
          });
        }

        req.validated = { ...req.validated, [source]: value };
        next();
      } catch (err) {
        res.status(500).json({ success: false, message: 'Validation error' });
      }
    };
  }
}

// Common validators
const CommonValidators = {
  required: (value) => !value ? 'Required field' : null,
  email: (value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? 'Invalid email' : null,
  minLength: (min) => (value) => value?.length < min ? `Minimum ${min} characters` : null,
  maxLength: (max) => (value) => value?.length > max ? `Maximum ${max} characters` : null,
  number: (value) => isNaN(value) ? 'Must be a number' : null,
  positive: (value) => value <= 0 ? 'Must be positive' : null,
  phone: (value) => !/^\+?[1-9]\d{1,14}$/.test(value) ? 'Invalid phone' : null,
  url: (value) => {
    try {
      new URL(value);
      return null;
    } catch {
      return 'Invalid URL';
    }
  },
  date: (value) => isNaN(Date.parse(value)) ? 'Invalid date' : null
};

module.exports = { ValidationRegistry, CommonValidators };
