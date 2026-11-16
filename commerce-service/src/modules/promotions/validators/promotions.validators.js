'use strict';

/**
 * Promotions domain validators for coupons.
 */

function failValidation(res, errors) {
  return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
}

const validateCreateCoupon = (req, res, next) => {
  const errors = [];
  if (!req.body || !req.body.name || req.body.name.trim().length < 2) errors.push('Coupon name is required');
  if (req.body.value === undefined || req.body.value === null) errors.push('Coupon value is required');
  if (errors.length) return failValidation(res, errors);
  next();
};

module.exports = {
  validateCreateCoupon,
};
