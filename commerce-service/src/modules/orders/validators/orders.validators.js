'use strict';

/**
 * Orders domain validators.
 */

function failValidation(res, errors) {
  return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
}

const validateCreateOrder = (req, res, next) => {
  const errors = [];
  if (!req.body.cart || !Array.isArray(req.body.cart) || req.body.cart.length === 0) {
    errors.push('Cart items are required');
  }
  if (!req.body.user) {
    errors.push('User info is required');
  }

  // Destination location validation
  const dest = req.body.destination;
  if (!dest) {
    errors.push('Delivery destination is required (destination.sectorId, destination.fullAddress)');
  } else {
    if (!dest.sectorId) errors.push('destination.sectorId is required');
    if (!dest.fullAddress || !String(dest.fullAddress).trim()) errors.push('destination.fullAddress is required');
    if (!dest.phone || !String(dest.phone).trim()) errors.push('destination.phone is required');
    if (dest.regionId && !dest.regionName) errors.push('destination.regionName is required when regionId is provided');
    if (dest.areaId && !dest.areaName) errors.push('destination.areaName is required when areaId is provided');
    if (dest.cityId && !dest.cityName) errors.push('destination.cityName is required when cityId is provided');
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

const validateUpdateOrderStatus = (req, res, next) => {
  const errors = [];
  if (!req.body || !req.body.status) {
    errors.push('Status is required');
  }
  if (errors.length) return failValidation(res, errors);
  next();
};

module.exports = {
  validateCreateOrder,
  validateUpdateOrderStatus,
};
