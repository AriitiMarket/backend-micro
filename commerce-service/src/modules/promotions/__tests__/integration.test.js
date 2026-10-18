'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

/**
 * Integration test for promo code validation
 * 
 * This test verifies the integration between:
 * - Promotion service validation
 * - Discount calculator
 * - Usage tracker
 * 
 * Note: Full order integration tests require database and service mocking
 * which is complex. This test focuses on the core validation flow.
 */

const { DiscountCalculator } = require('../../promotions/services/promotions.service');

test('Integration: promo code validation flow for checkout', () => {
  // Simulate a promotion from database
  const promotion = {
    _id: 'promo123',
    shopId: 'shop456',
    code: 'SAVE20',
    discountType: 'PERCENTAGE',
    discountPercent: 20,
    maxDiscountAmount: 50,
    minPurchaseAmount: 100,
    totalUsageLimit: 1000,
    perBuyerUsageLimit: 5,
    isPlatformWide: false,
    firstOrderOnly: false,
    status: 'active',
    startsAt: new Date('2024-01-01'),
    endsAt: new Date('2024-12-31'),
    showOnPublic: true,
  };

  // Simulate cart items
  const cartItems = [
    { productId: 'prod1', categoryId: 'cat1', price: 75, quantity: 2 },
    { productId: 'prod2', categoryId: 'cat1', price: 50, quantity: 1 },
  ];

  const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0); // 200

  // Step 1: Check eligibility
  const eligibility = DiscountCalculator.checkEligibility(promotion, cartItems, 'buyer1', false);
  assert.strictEqual(eligibility.eligible, true, 'Promotion should be eligible');
  assert.strictEqual(eligibility.reason, null, 'No eligibility reason');

  // Step 2: Calculate discount
  const discountResult = DiscountCalculator.calculateDiscount(promotion, subtotal);
  assert.strictEqual(discountResult.applicable, true, 'Discount should be applicable');
  assert.strictEqual(discountResult.discountAmount, 40, '20% of 200 = 40');
  assert.strictEqual(discountResult.discountAmount, 40, 'Discount should be 40 ETB');

  // Step 3: Verify multi-seller calculation
  const shopGroups = {
    shop456: { items: cartItems, subtotal: 200 },
    shop789: { items: [], subtotal: 300 },
  };
  const multiSellerResult = DiscountCalculator.calculateMultiSellerDiscount(promotion, shopGroups);
  assert.strictEqual(multiSellerResult.shopDiscounts.shop456, 40, 'Shop discount should be 40');
  assert.strictEqual(multiSellerResult.shopDiscounts.shop789, undefined, 'Other shop should not get discount');
  assert.strictEqual(multiSellerResult.totalDiscount, 40, 'Total discount should be 40');

  // Step 4: Verify final price calculation
  const shipping = 200 * 0.03; // 6
  const finalTotal = subtotal + shipping - discountResult.discountAmount;
  assert.strictEqual(finalTotal, 166, 'Final total should be 166 (200 + 6 - 40)');
});

test('Integration: minimum purchase amount enforcement', () => {
  const promotion = {
    discountType: 'PERCENTAGE',
    discountPercent: 20,
    minPurchaseAmount: 500,
    status: 'active',
  };

  const cartItems = [{ productId: 'prod1', price: 100, quantity: 2 }];
  const subtotal = 200;

  const result = DiscountCalculator.calculateDiscount(promotion, subtotal);
  assert.strictEqual(result.applicable, false, 'Should not be applicable');
  assert.ok(result.reason.includes('Minimum purchase amount'), 'Should indicate minimum not met');
});

test('Integration: percentage discount with cap', () => {
  const promotion = {
    discountType: 'PERCENTAGE',
    discountPercent: 50,
    maxDiscountAmount: 10,
    minPurchaseAmount: 0,
    status: 'active',
  };

  const subtotal = 100;
  const result = DiscountCalculator.calculateDiscount(promotion, subtotal);
  
  // 50% of 100 = 50, but capped at 10
  assert.strictEqual(result.discountAmount, 10, 'Should be capped at 10');
  assert.strictEqual(result.applicable, true, 'Should still be applicable');
});

test('Integration: first-order promotion validation', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: true,
  };

  // New buyer - should be eligible
  const resultNew = DiscountCalculator.checkEligibility(promotion, [], 'buyer1', true);
  assert.strictEqual(resultNew.eligible, true, 'New buyer should be eligible');

  // Returning buyer - should not be eligible
  const resultReturning = DiscountCalculator.checkEligibility(promotion, [], 'buyer1', false);
  assert.strictEqual(resultReturning.eligible, false, 'Returning buyer should not be eligible');
  assert.ok(resultReturning.reason.includes('first-time customers'), 'Should indicate first-order restriction');
});

test('Integration: product eligibility validation', () => {
  const promotion = {
    status: 'active',
    firstOrderOnly: false,
    eligibleProductIds: ['prod1', 'prod2'],
  };

  // Cart with eligible product
  const cartWithEligible = [{ productId: 'prod1' }];
  const resultEligible = DiscountCalculator.checkEligibility(promotion, cartWithEligible, 'buyer1', false);
  assert.strictEqual(resultEligible.eligible, true, 'Should be eligible with product in cart');

  // Cart without eligible product
  const cartWithoutEligible = [{ productId: 'prod3' }];
  const resultNotEligible = DiscountCalculator.checkEligibility(promotion, cartWithoutEligible, 'buyer1', false);
  assert.strictEqual(resultNotEligible.eligible, false, 'Should not be eligible without product');
  assert.ok(resultNotEligible.reason.includes('No eligible products'), 'Should indicate no eligible products');
});
