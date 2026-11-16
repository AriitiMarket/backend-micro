'use strict';

/**
 * Finance domain validators for payments and payouts.
 */

function failValidation(res, errors) {
  return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
}

const validatePayoutRequest = (req, res, next) => {
  const errors = [];
  const body = req.body || {};

  const amount = Number(body.amount);
  if (body.amount === undefined || body.amount === null || !Number.isFinite(amount) || amount <= 0) {
    errors.push('Valid positive amount is required');
  }

  const validMethods = ['BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHECK'];
  if (!body.payoutMethod || !validMethods.includes(body.payoutMethod)) {
    errors.push(`Payout method must be one of: ${validMethods.join(', ')}`);
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

const validatePaymentInitiation = (req, res, next) => {
  const errors = [];
  const body = req.body || {};

  if (!body.orderId) {
    errors.push('orderId is required');
  }

  if (errors.length) return failValidation(res, errors);
  next();
};

module.exports = {
  validatePayoutRequest,
  validatePaymentInitiation,
};
