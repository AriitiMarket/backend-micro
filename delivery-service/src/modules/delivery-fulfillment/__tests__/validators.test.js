/**
 * Handoff and package validation tests.
 *
 * These are the checks that stand between a marketplace order and a delivery
 * record: the Commerce handoff (`POST /internal/delivery/request`) and the admin
 * creation route both run `validateDeliveryCreationInput`, so every rule here is
 * enforced at the only two doors into the delivery domain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const validators = require('../validators');

function basePayload(overrides = {}) {
  return {
    orderId: 'ORDER-1001',
    sellerId: 'seller-1',
    buyerId: 'buyer-1',
    pickupAddress: { shopName: 'Shop', cityName: 'Harar', addressDetail: 'Street 1' },
    deliveryAddress: { cityName: 'Harar', sectorName: 'Sector 01', addressDetail: 'Home 1' },
    paymentMethod: 'COD',
    paymentAmount: 500,
    items: [{ name: 'Bag of coffee', quantity: 2, weight: 1, value: 250 }],
    ...overrides,
  };
}

function expectValidationError(payload, matcher) {
  assert.throws(
    () => validators.validateDeliveryCreationInput(payload),
    (err) => err.status === 400 && err.code === 'VALIDATION_ERROR' && matcher(err),
  );
}

test('a complete handoff payload is accepted', () => {
  assert.ok(validators.validateDeliveryCreationInput(basePayload()));
});

test('an address may be identified by a location reference instead of text', () => {
  const payload = basePayload({
    pickupAddress: undefined,
    deliveryAddress: undefined,
    pickupLocationId: '507f1f77bcf86cd799439011',
    destinationLocationId: '507f1f77bcf86cd799439012',
  });
  assert.ok(validators.validateDeliveryCreationInput(payload));
});

test('missing order, seller or buyer is rejected', () => {
  expectValidationError(basePayload({ orderId: undefined }), (err) => err.errors.join(' ').includes('orderId'));
  expectValidationError(basePayload({ orderId: '' }), (err) => err.errors.join(' ').includes('orderId'));
  expectValidationError(basePayload({ sellerId: null }), (err) => err.errors.join(' ').includes('sellerId'));
  expectValidationError(basePayload({ buyerId: '  ' }), (err) => err.errors.join(' ').includes('buyerId'));
});

test('missing pickup or destination is rejected', () => {
  expectValidationError(
    basePayload({ pickupAddress: undefined, pickupLocationId: undefined }),
    (err) => err.errors.join(' ').includes('pickup point'),
  );
  expectValidationError(
    basePayload({ deliveryAddress: undefined, destinationLocationId: undefined }),
    (err) => err.errors.join(' ').includes('destination'),
  );
});

test('a location reference must be an identifier, not a free string', () => {
  expectValidationError(
    basePayload({ pickupLocationId: 'not-an-object-id' }),
    (err) => err.errors.join(' ').includes('pickupLocationId'),
  );
  expectValidationError(
    basePayload({ destinationLocationId: '../etc/passwd' }),
    (err) => err.errors.join(' ').includes('destinationLocationId'),
  );
});

test('impossible coordinates are rejected', () => {
  expectValidationError(
    basePayload({ deliveryAddress: { cityName: 'Harar', coordinates: { latitude: 999, longitude: 42 } } }),
    (err) => err.errors.join(' ').includes('latitude'),
  );
  expectValidationError(
    basePayload({ pickupAddress: { shopName: 'S', coordinates: { latitude: 9.3, longitude: 999 } } }),
    (err) => err.errors.join(' ').includes('longitude'),
  );
  expectValidationError(
    basePayload({ deliveryAddress: { cityName: 'Harar', coordinates: { latitude: 'north', longitude: 42 } } }),
    (err) => err.errors.join(' ').includes('must be a number'),
  );
  // Nulls are the Commerce "not pinned on the map" case and stay valid.
  assert.ok(validators.validateDeliveryCreationInput(basePayload({
    deliveryAddress: { cityName: 'Harar', addressDetail: 'Home 1', coordinates: { latitude: null, longitude: null } },
  })));
});

test('negative package quantities, weights and values are rejected', () => {
  expectValidationError(
    basePayload({ items: [{ name: 'x', quantity: -3 }] }),
    (err) => err.errors.join(' ').includes('cannot be negative'),
  );
  expectValidationError(
    basePayload({ items: [{ name: 'x', weight: -1 }] }),
    (err) => err.errors.join(' ').includes('cannot be negative'),
  );
  expectValidationError(
    basePayload({ items: [{ name: 'x', value: -5 }] }),
    (err) => err.errors.join(' ').includes('cannot be negative'),
  );
  expectValidationError(basePayload({ items: 'one bag' }), (err) => err.errors.join(' ').includes('must be an array'));
  expectValidationError(
    basePayload({ items: [{ name: 'x', quantity: validators.MAX_ITEM_QUANTITY + 1 }] }),
    (err) => err.errors.join(' ').includes('must be at most'),
  );
});

test('negative totals and payment amounts are rejected', () => {
  expectValidationError(basePayload({ paymentAmount: -100 }), (err) => err.errors.join(' ').includes('paymentAmount'));
  expectValidationError(basePayload({ totalValue: -1 }), (err) => err.errors.join(' ').includes('totalValue'));
  expectValidationError(basePayload({ totalWeight: -1 }), (err) => err.errors.join(' ').includes('totalWeight'));
});

test('an unsupported delivery type or payment method is rejected', () => {
  expectValidationError(
    basePayload({ deliveryType: 'teleport' }),
    (err) => err.errors.join(' ').includes('Unsupported delivery type'),
  );
  assert.ok(validators.validateDeliveryCreationInput(basePayload({ deliveryType: 'express' })));
  expectValidationError(
    basePayload({ paymentMethod: 'GOLD' }),
    (err) => err.errors.join(' ').includes('paymentMethod'),
  );
});

test('the payment method is normalized case-insensitively', () => {
  assert.equal(validators.normalizePaymentMethod('cod'), 'COD');
  assert.equal(validators.normalizePaymentMethod('prepaid'), 'PREPAID');
  assert.equal(validators.normalizePaymentMethod(undefined), 'COD');
  assert.equal(validators.normalizePaymentMethod('crypto'), null);
});

test('an unknown delivery status is rejected at the boundary', () => {
  expectValidationError(basePayload({ status: 'teleported' }), (err) => err.errors.join(' ').includes('Unknown delivery status'));
  assert.ok(validators.validateDeliveryCreationInput(basePayload({ status: 'PENDING' })));
});



test('the status payload requires a known status and is normalized', () => {
  assert.equal(validators.validateStatusPayload({ status: 'PICKED_UP' }).status, 'pickup');
  assert.throws(() => validators.validateStatusPayload({}), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => validators.validateStatusPayload({ status: 'nope' }), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => validators.validateStatusPayload({ status: 'delivered', note: 'x'.repeat(600) }));
});

test('cancellation requires a reason and an explicit boolean override', () => {
  const payload = validators.validateCancelPayload({ reason: 'Buyer cancelled' });
  assert.equal(payload.reason, 'Buyer cancelled');
  assert.equal(payload.override, false);
  assert.throws(() => validators.validateCancelPayload({}), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(
    () => validators.validateCancelPayload({ reason: 'x', override: 'yes' }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
});

test('the failure payload requires a reason and a known next action', () => {
  assert.equal(validators.validateFailPayload({ reason: 'Buyer unavailable' }).reason, 'Buyer unavailable');
  assert.throws(() => validators.validateFailPayload({}), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(
    () => validators.validateFailPayload({ reason: 'x', nextAction: 'teleport' }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
  assert.equal(validators.validateFailPayload({ reason: 'x', nextAction: 'retry' }).nextAction, 'retry');
  // `return` went with the returns flow: there is no flow that can act on it, so
  // recording it would only ever produce a delivery nothing will move again.
  assert.throws(
    () => validators.validateFailPayload({ reason: 'x', nextAction: 'return' }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
});

test('a status update runs the validator for the status it is moving to', () => {
  // The branch validators used to be dead code: `status` was the only check, so
  // a `failed` delivery could be written with no reason at all.
  assert.throws(
    () => validators.validateStatusPayload({ status: 'failed' }),
    (err) => err.code === 'VALIDATION_ERROR' && /"reason" is required/.test(err.errors.join(' ')),
  );
  assert.equal(
    validators.validateStatusPayload({ status: 'failed', reason: 'Closed', nextAction: 'retry' }).nextAction,
    'retry',
  );
  assert.throws(
    () => validators.validateStatusPayload({ status: 'cancelled' }),
    (err) => err.code === 'VALIDATION_ERROR' && /"reason" is required/.test(err.errors.join(' ')),
  );
  // Either spelling of the proof is accepted, never both.
  const viaProof = validators.validateStatusPayload({ status: 'delivered', proof: { type: 'photo' } });
  assert.deepEqual(viaProof.proof, { type: 'photo' });
  assert.deepEqual(
    validators.validateStatusPayload({ status: 'delivered', proofOfDelivery: { type: 'signature' } }).proof,
    { type: 'signature' },
  );
  assert.throws(
    () => validators.validateStatusPayload({
      status: 'delivered', proof: { type: 'photo' }, proofOfDelivery: { type: 'photo' },
    }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
});

test('a status update rejects fields outside the status payload contract', () => {
  // `status` used to spread the whole body, so a status change could also
  // assign providerId / retryCount / anything else on the document.
  assert.throws(
    () => validators.validateStatusPayload({ status: 'in_transit', providerId: '507f1f77bcf86cd799439011' }),
    (err) => err.code === 'VALIDATION_ERROR' && /Unsupported field/.test(err.errors.join(' ')),
  );
  const clean = validators.validateStatusPayload({ status: 'in_transit', note: 'Left the hub' });
  assert.equal(clean.note, 'Left the hub');
  assert.equal(clean.providerId, undefined);
});

test('the patch payload rejects unknown fields (no mass assignment)', () => {
  assert.ok(validators.validatePatchPayload({ portId: '507f1f77bcf86cd799439011' }));
  assert.throws(
    () => validators.validatePatchPayload({ status: 'delivered', deliveredAt: new Date() }),
    (err) => err.errors.join(' ').includes('Unknown'),
  );
  assert.throws(() => validators.validatePatchPayload({}), (err) => err.code === 'VALIDATION_ERROR');
});

test('the list filter rejects unknown statuses and bounds pagination', () => {
  const { filter, page, limit } = validators.buildDeliveryFilter({ status: 'PICKED_UP,in_transit', page: '2', limit: '999' });
  assert.deepEqual(filter.status, { $in: ['pickup', 'in_transit'] });
  assert.equal(page, 2);
  assert.equal(limit, 200, 'the page size is capped');
  assert.throws(() => validators.buildDeliveryFilter({ status: 'teleported' }), (err) => err.code === 'UNKNOWN_STATUS');
});
