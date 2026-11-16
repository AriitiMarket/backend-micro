'use strict';

/**
 * Aggregator that re-exports domain-specific validators for backwards compatibility.
 */

const catalogValidators = require('../../modules/catalog/validators/catalog.validators');
const sellingValidators = require('../../modules/selling/validators/selling.validators');
const ordersValidators = require('../../modules/orders/validators/orders.validators');
const financeValidators = require('../../modules/finance/validators/finance.validators');
const promotionsValidators = require('../../modules/promotions/validators/promotions.validators');

module.exports = {
  ...catalogValidators,
  ...sellingValidators,
  ...ordersValidators,
  ...financeValidators,
  ...promotionsValidators,
};
