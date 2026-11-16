'use strict';

/**
 * Selling domain validators for shops.
 */

function failValidation(res, errors) {
  return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
}

const validateCreateShop = (req, res, next) => {
  const errors = [];
  if (!req.body.name || String(req.body.name).trim().length < 2) errors.push('Business name is required (min 2 chars)');
  if (!req.body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) errors.push('Valid email is required');
  if (!req.body.address || !String(req.body.address).trim()) errors.push('Address is required');
  if (req.body.phoneNumber === undefined || req.body.phoneNumber === null || req.body.phoneNumber === '' ||
      !/^\+?[0-9\s\-()]{5,20}$/.test(String(req.body.phoneNumber).trim())) {
    errors.push('Valid phone number is required');
  }
  if (req.body.zipCode !== undefined && req.body.zipCode !== null && req.body.zipCode !== '' &&
      !/^[0-9]{1,10}$/.test(String(req.body.zipCode).trim())) {
    errors.push('Zip code must be numeric');
  }
  if (req.body.locationId !== undefined && req.body.locationId !== null && req.body.locationId !== '' &&
      typeof req.body.locationId !== 'string') {
    errors.push('locationId must be a string id');
  }
  if (req.body.sectorId !== undefined && req.body.sectorId !== null && req.body.sectorId !== '' &&
      typeof req.body.sectorId !== 'string') {
    errors.push('sectorId must be a string id');
  }
  if (errors.length) return failValidation(res, errors);
  next();
};

const validateUpdateShop = (req, res, next) => {
  const errors = [];
  const body = req.body || {};

  if (body.name !== undefined && body.name !== null && String(body.name).trim().length < 2) {
    errors.push('Business name must be at least 2 chars');
  }
  if (body.email !== undefined && body.email !== null && body.email !== '' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email))) {
    errors.push('Valid email is required');
  }
  if (body.address !== undefined && body.address !== null && body.address !== '' && !String(body.address).trim()) {
    errors.push('Address cannot be empty');
  }
  if (body.phoneNumber !== undefined && body.phoneNumber !== null && body.phoneNumber !== '' &&
      !/^\+?[0-9\s\-()]{5,20}$/.test(String(body.phoneNumber).trim())) {
    errors.push('Valid phone number is required');
  }
  if (body.zipCode !== undefined && body.zipCode !== null && body.zipCode !== '' &&
      !/^[0-9]{1,10}$/.test(String(body.zipCode).trim())) {
    errors.push('Zip code must be numeric');
  }
  if (body.pickupEnabled !== undefined && typeof body.pickupEnabled !== 'boolean') {
    errors.push('pickupEnabled must be a boolean');
  }
  if (body.pickupHours !== undefined && String(body.pickupHours).length > 200) {
    errors.push('pickupHours must be at most 200 characters');
  }
  for (const key of ['locationId', 'sectorId', 'shopId']) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '' && typeof body[key] !== 'string') {
      errors.push(`${key} must be a string id`);
    }
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

module.exports = {
  validateCreateShop,
  validateUpdateShop,
};
