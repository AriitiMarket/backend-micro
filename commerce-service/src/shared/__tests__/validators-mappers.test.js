'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const catalogValidators = require('../../modules/catalog/validators/catalog.validators');
const sellingValidators = require('../../modules/selling/validators/selling.validators');
const ordersValidators = require('../../modules/orders/validators/orders.validators');
const financeValidators = require('../../modules/finance/validators/finance.validators');
const promotionsValidators = require('../../modules/promotions/validators/promotions.validators');
const commerceValidators = require('../validators/commerce.validators');

const { toOrderResponse, toOrderListResponse } = require('../../modules/orders/mappers/orders.mapper');
const { toPayoutResponse, toPayoutListResponse, toWalletResponse } = require('../../modules/finance/mappers/finance.mapper');
const { toProductResponse, toProductListResponse } = require('../../modules/catalog/mappers/products.mapper');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function runValidator(validator, body) {
  const req = { body };
  const res = mockRes();
  let nextCalled = false;
  validator(req, res, () => { nextCalled = true; });
  return { nextCalled, res };
}

describe('Modular Validators & Aggregator Re-export', () => {
  it('commerce.validators re-exports all domain validator functions', () => {
    assert.strictEqual(typeof commerceValidators.validateCreateProduct, 'function');
    assert.strictEqual(typeof commerceValidators.validateUpdateProduct, 'function');
    assert.strictEqual(typeof commerceValidators.validateCreateShop, 'function');
    assert.strictEqual(typeof commerceValidators.validateUpdateShop, 'function');
    assert.strictEqual(typeof commerceValidators.validateCreateOrder, 'function');
    assert.strictEqual(typeof commerceValidators.validateCreateCoupon, 'function');
    assert.strictEqual(typeof commerceValidators.validatePayoutRequest, 'function');
    assert.strictEqual(typeof commerceValidators.validatePaymentInitiation, 'function');
  });

  it('validateCreateProduct accepts valid payload and rejects missing fields', () => {
    const valid = runValidator(catalogValidators.validateCreateProduct, {
      name: 'Valid Product',
      description: 'Valid product description of decent length',
      category: 'Electronics',
      discountPrice: 150,
      stock: 10,
    });
    assert.strictEqual(valid.nextCalled, true);

    const invalid = runValidator(catalogValidators.validateCreateProduct, {
      name: 'A',
      stock: -5,
    });
    assert.strictEqual(invalid.nextCalled, false);
    assert.strictEqual(invalid.res.statusCode, 400);
    assert.strictEqual(invalid.res.body.code, 'VALIDATION_ERROR');
  });

  it('validatePayoutRequest enforces positive amount and valid method', () => {
    const valid = runValidator(financeValidators.validatePayoutRequest, {
      amount: 500,
      payoutMethod: 'BANK_TRANSFER',
    });
    assert.strictEqual(valid.nextCalled, true);

    const invalid = runValidator(financeValidators.validatePayoutRequest, {
      amount: -100,
      payoutMethod: 'INVALID_METHOD',
    });
    assert.strictEqual(invalid.nextCalled, false);
    assert.strictEqual(invalid.res.statusCode, 400);
  });
});

describe('Response DTO Mappers', () => {
  it('toOrderResponse strips pickupCodeHash and __v', () => {
    const rawOrder = {
      _id: 'order-1',
      buyerId: 'buyer-1',
      sellerId: 'seller-1',
      status: 'Processing',
      totalPrice: 1200,
      pickupCodeHash: 'super-secret-hash',
      __v: 2,
    };
    const dto = toOrderResponse(rawOrder);
    assert.strictEqual(dto.id, 'order-1');
    assert.strictEqual(dto.totalPrice, 1200);
    assert.strictEqual(dto.pickupCodeHash, undefined, 'pickupCodeHash must be stripped');
    assert.strictEqual(dto.__v, undefined, '__v must be stripped');
  });

  it('toOrderListResponse handles arrays', () => {
    const list = toOrderListResponse([{ _id: 'o1' }, { _id: 'o2' }]);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, 'o1');
  });

  it('toPayoutResponse strips __v and formats netPayoutAmount', () => {
    const rawPayout = {
      _id: 'p-1',
      sellerId: 's-1',
      amount: 1000,
      processingFee: 10,
      netPayoutAmount: 990,
      __v: 0,
    };
    const dto = toPayoutResponse(rawPayout);
    assert.strictEqual(dto.id, 'p-1');
    assert.strictEqual(dto.amount, 1000);
    assert.strictEqual(dto.netPayoutAmount, 990);
    assert.strictEqual(dto.__v, undefined);
  });

  it('toWalletResponse formats balances and strips __v', () => {
    const rawWallet = {
      _id: 'w-1',
      sellerId: 's-1',
      availableBalance: 2500,
      pendingBalance: 500,
      __v: 1,
    };
    const dto = toWalletResponse(rawWallet);
    assert.strictEqual(dto.id, 'w-1');
    assert.strictEqual(dto.availableBalance, 2500);
    assert.strictEqual(dto.pendingBalance, 500);
    assert.strictEqual(dto.__v, undefined);
  });

  it('toProductResponse formats product fields and strips __v', () => {
    const rawProduct = {
      _id: 'prod-1',
      name: 'Product Name',
      discountPrice: 200,
      stock: 15,
      __v: 0,
    };
    const dto = toProductResponse(rawProduct);
    assert.strictEqual(dto.id, 'prod-1');
    assert.strictEqual(dto.price, 200);
    assert.strictEqual(dto.stock, 15);
    assert.strictEqual(dto.__v, undefined);
  });
});
