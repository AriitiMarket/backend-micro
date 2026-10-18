'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { DiscountCalculator } = require('../services/promotions.service');

test('validateCodeFormat accepts valid codes', () => {
  assert.strictEqual(DiscountCalculator.validateCodeFormat('SUMMER2024').valid, true);
  assert.strictEqual(DiscountCalculator.validateCodeFormat('SAVE10').valid, true);
  assert.strictEqual(DiscountCalculator.validateCodeFormat('ABCD').valid, true);
});

test('validateCodeFormat rejects codes that are too short', () => {
  const result = DiscountCalculator.validateCodeFormat('ABC');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('at least 4 characters'));
});

test('validateCodeFormat rejects codes that are too long', () => {
  const result = DiscountCalculator.validateCodeFormat('ABCDEFGHIJKLMNO123456');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('no more than 20 characters'));
});

test('validateCodeFormat rejects codes with special characters', () => {
  const result = DiscountCalculator.validateCodeFormat('SUMMER-2024');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('letters and numbers'));
});

test('validateCodeFormat rejects empty codes', () => {
  const result = DiscountCalculator.validateCodeFormat('');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('required'));
});

test('normalizeCode normalizes to uppercase', () => {
  assert.strictEqual(DiscountCalculator.normalizeCode('summer2024'), 'SUMMER2024');
});

test('normalizeCode removes whitespace', () => {
  assert.strictEqual(DiscountCalculator.normalizeCode('SUMMER 2024'), 'SUMMER2024');
});

test('normalizeCode handles mixed case and spaces', () => {
  assert.strictEqual(DiscountCalculator.normalizeCode('Summer 2024'), 'SUMMER2024');
});

test('normalizeCode returns null for empty input', () => {
  assert.strictEqual(DiscountCalculator.normalizeCode(''), null);
  assert.strictEqual(DiscountCalculator.normalizeCode(null), null);
});

test('calculateDiscount calculates percentage discount', () => {
  const promotion = {
    discountType: 'PERCENTAGE',
    discountPercent: 20,
    minPurchaseAmount: 0,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 100);
  assert.strictEqual(result.discountAmount, 20);
  assert.strictEqual(result.applicable, true);
});

test('calculateDiscount respects max discount cap for percentage', () => {
  const promotion = {
    discountType: 'PERCENTAGE',
    discountPercent: 50,
    maxDiscountAmount: 10,
    minPurchaseAmount: 0,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 100);
  assert.strictEqual(result.discountAmount, 10); // 50% of 100 = 50, capped at 10
  assert.strictEqual(result.applicable, true);
});

test('calculateDiscount calculates fixed amount discount', () => {
  const promotion = {
    discountType: 'FIXED_AMOUNT',
    fixedAmount: 15,
    minPurchaseAmount: 0,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 100);
  assert.strictEqual(result.discountAmount, 15);
  assert.strictEqual(result.applicable, true);
});

test('calculateDiscount caps fixed discount at subtotal', () => {
  const promotion = {
    discountType: 'FIXED_AMOUNT',
    fixedAmount: 150,
    minPurchaseAmount: 0,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 100);
  assert.strictEqual(result.discountAmount, 100); // Can't discount more than subtotal
  assert.strictEqual(result.applicable, true);
});

test('calculateDiscount rejects when minimum purchase not met', () => {
  const promotion = {
    discountType: 'PERCENTAGE',
    discountPercent: 20,
    minPurchaseAmount: 50,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 30);
  assert.strictEqual(result.discountAmount, 0);
  assert.strictEqual(result.applicable, false);
  assert.ok(result.reason.includes('Minimum purchase amount'));
});

test('calculateDiscount handles free delivery type', () => {
  const promotion = {
    discountType: 'FREE_DELIVERY',
    minPurchaseAmount: 0,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 100);
  assert.strictEqual(result.discountAmount, 0);
  assert.strictEqual(result.isFreeDelivery, true);
  assert.strictEqual(result.applicable, true);
});

test('calculateDiscount rounds to 2 decimal places', () => {
  const promotion = {
    discountType: 'PERCENTAGE',
    discountPercent: 33.33,
    minPurchaseAmount: 0,
  };
  const result = DiscountCalculator.calculateDiscount(promotion, 100);
  assert.strictEqual(result.discountAmount, 33.33);
});

test('checkEligibility allows eligible promotion', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: false,
    eligibleProductIds: [],
    eligibleCategoryIds: [],
  };
  const cartItems = [{ productId: '123', categoryId: 'cat1' }];
  const result = DiscountCalculator.checkEligibility(promotion, cartItems, 'buyer1', false);
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.reason, null);
});

test('checkEligibility rejects inactive promotion', () => {
  const promotion = {
    status: 'paused',
    firstOrderOnly: false,
  };
  const result = DiscountCalculator.checkEligibility(promotion, [], 'buyer1', false);
  assert.strictEqual(result.eligible, false);
  assert.ok(result.reason.includes('paused'));
});

test('checkEligibility rejects first-order promotion for returning buyer', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: true,
  };
  const result = DiscountCalculator.checkEligibility(promotion, [], 'buyer1', false);
  assert.strictEqual(result.eligible, false);
  assert.ok(result.reason.includes('first-time customers'));
});

test('checkEligibility allows first-order promotion for new buyer', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: true,
  };
  const result = DiscountCalculator.checkEligibility(promotion, [], 'buyer1', true);
  assert.strictEqual(result.eligible, true);
});

test('checkEligibility rejects when no eligible products in cart', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: false,
    eligibleProductIds: ['prod1', 'prod2'],
  };
  const cartItems = [{ productId: 'prod3' }];
  const result = DiscountCalculator.checkEligibility(promotion, cartItems, 'buyer1', false);
  assert.strictEqual(result.eligible, false);
  assert.ok(result.reason.includes('No eligible products'));
});

test('checkEligibility allows when eligible product in cart', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: false,
    eligibleProductIds: ['prod1', 'prod2'],
  };
  const cartItems = [{ productId: 'prod1' }];
  const result = DiscountCalculator.checkEligibility(promotion, cartItems, 'buyer1', false);
  assert.strictEqual(result.eligible, true);
});

test('checkEligibility rejects when no eligible categories in cart', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: false,
    eligibleCategoryIds: ['cat1', 'cat2'],
  };
  const cartItems = [{ categoryId: 'cat3' }];
  const result = DiscountCalculator.checkEligibility(promotion, cartItems, 'buyer1', false);
  assert.strictEqual(result.eligible, false);
  assert.ok(result.reason.includes('No eligible categories'));
});

test('calculateMultiSellerDiscount applies shop-owned promotion only to that shop', () => {
  const promotion = {
    shopId: 'shop1',
    discountType: 'PERCENTAGE',
    discountPercent: 10,
    minPurchaseAmount: 0,
    isPlatformWide: false,
  };
  const shopGroups = {
    shop1: { items: [], subtotal: 100 },
    shop2: { items: [], subtotal: 200 },
  };
  const result = DiscountCalculator.calculateMultiSellerDiscount(promotion, shopGroups);
  assert.strictEqual(result.shopDiscounts.shop1, 10);
  assert.strictEqual(result.shopDiscounts.shop2, undefined);
  assert.strictEqual(result.totalDiscount, 10);
});

test('calculateMultiSellerDiscount applies platform-wide promotion to all shops', () => {
  const promotion = {
    shopId: 'shop1',
    discountType: 'PERCENTAGE',
    discountPercent: 10,
    minPurchaseAmount: 0,
    isPlatformWide: true,
  };
  const shopGroups = {
    shop1: { items: [], subtotal: 100 },
    shop2: { items: [], subtotal: 200 },
  };
  const result = DiscountCalculator.calculateMultiSellerDiscount(promotion, shopGroups);
  assert.strictEqual(result.shopDiscounts.shop1, 10);
  assert.strictEqual(result.shopDiscounts.shop2, 20);
  assert.strictEqual(result.totalDiscount, 30);
});

test('calculateMultiSellerDiscount handles empty shop groups', () => {
  const promotion = {
    shopId: 'shop1',
    discountType: 'PERCENTAGE',
    discountPercent: 10,
    minPurchaseAmount: 0,
    isPlatformWide: false,
  };
  const result = DiscountCalculator.calculateMultiSellerDiscount(promotion, {});
  assert.deepStrictEqual(result.shopDiscounts, {});
  assert.strictEqual(result.totalDiscount, 0);
});
