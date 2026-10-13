'use strict';
/**
 * Commerce → Delivery handoff integration tests.
 *
 * Runs against a real MongoDB through the real express app with the gateway's
 * identity headers, so the assertions cover the whole path: routing,
 * gateway-only admission, validation, idempotency, materialization and the
 * shape of what is persisted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');
const { seedGeography, handoffPayload, handoff, createDelivery } = require('./fixtures');

const harness = createHarness('request');
let geo = null;
let dbReady = false;

test.before(async () => {
  dbReady = await harness.start();
  if (dbReady) geo = await seedGeography(harness.models);
});

test.after(async () => { await harness.stop(); });

/** Run the body only when the database is available; otherwise skip loudly. */
function it(name, fn) {
  test(name, async (t) => {
    if (!dbReady) {
      t.skip('MongoDB is not reachable (set ARITII_TEST_MONGO) — integration suite skipped');
      return;
    }
    await fn(t);
  });
}

it('a valid handoff creates a request and a pending delivery', async () => {
  const res = await handoff(harness, handoffPayload(geo, 'ORD-1', { buyerId: 'buyer-1', sellerId: 'seller-1' }));
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.request.orderId, 'ORD-1');

  const delivery = await harness.models.Delivery.findOne({ orderId: 'ORD-1' });
  assert.ok(delivery, 'the delivery is materialized so an admin can dispatch it immediately');
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.sellerId, 'seller-1');
  assert.equal(delivery.buyerId, 'buyer-1');
  assert.equal(String(delivery.destination.locationId), String(geo.city._id));
  assert.equal(String(delivery.origin.locationId), String(geo.city._id));
  assert.equal(delivery.destination.cityName, geo.city.name);
  assert.equal(String(delivery.destination.zoneId), String(geo.zone._id), 'the zone is resolved from the destination');
  assert.equal(delivery.idempotencyKey, 'order:ORD-1');
});

it('the same order handed over twice yields exactly one request and one delivery', async () => {
  const payload = handoffPayload(geo, 'ORD-2');
  const first = await handoff(harness, payload);
  const second = await handoff(harness, payload);
  const third = await handoff(harness, payload);

  assert.equal(first.status, 201);
  assert.ok([200, 201].includes(second.status));
  assert.equal(String(first.body.request._id), String(second.body.request._id), 'the same request is returned');
  assert.equal(String(first.body.request._id), String(third.body.request._id));

  assert.equal(await harness.models.DeliveryRequest.countDocuments({ orderId: 'ORD-2' }), 1);
  assert.equal(await harness.models.Delivery.countDocuments({ orderId: 'ORD-2' }), 1);
});

it('an invalid order id, missing parties or missing addresses are rejected cleanly', async () => {
  const cases = [
    { name: 'missing orderId', payload: handoffPayload(geo, undefined) },
    { name: 'empty orderId', payload: handoffPayload(geo, '') },
    { name: 'missing sellerId', payload: handoffPayload(geo, 'ORD-3', { sellerId: '' }) },
    { name: 'missing buyerId', payload: handoffPayload(geo, 'ORD-3', { buyerId: null }) },
    { name: 'missing pickup', payload: handoffPayload(geo, 'ORD-3', { pickupAddress: undefined, pickupLocationId: undefined }) },
    { name: 'missing destination', payload: handoffPayload(geo, 'ORD-3', { deliveryAddress: undefined, destinationLocationId: undefined }) },
  ];
  for (const { name, payload } of cases) {
    const res = await handoff(harness, payload);
    assert.equal(res.status, 400, `${name} must be a 400`);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0, `${name} must explain the problem`);
  }
  assert.equal(await harness.models.Delivery.countDocuments({ orderId: 'ORD-3' }), 0, 'nothing was persisted');
});

it('an invalid location reference, coordinates or package quantities are rejected', async () => {
  const cases = [
    { name: 'unknown pickup location string', payload: handoffPayload(geo, 'ORD-4', { pickupLocationId: 'not-an-id' }) },
    { name: 'invalid coordinates', payload: handoffPayload(geo, 'ORD-4', { deliveryAddress: { ...geo.deliveryAddress, coordinates: { latitude: 500, longitude: 42 } } }) },
    { name: 'negative quantity', payload: handoffPayload(geo, 'ORD-4', { items: [{ name: 'x', quantity: -2 }] }) },
    { name: 'negative payment', payload: handoffPayload(geo, 'ORD-4', { paymentAmount: -50 }) },
    { name: 'unsupported delivery type', payload: handoffPayload(geo, 'ORD-4', { deliveryType: 'submarine' }) },
    { name: 'unsupported payment method', payload: handoffPayload(geo, 'ORD-4', { paymentMethod: 'CHEQUE' }) },
  ];
  for (const { name, payload } of cases) {
    const res = await handoff(harness, payload);
    assert.equal(res.status, 400, `${name} must be a 400`);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
  assert.equal(await harness.models.Delivery.countDocuments({ orderId: 'ORD-4' }), 0);
});

it('a handoff of an inactive destination location is refused', async () => {
  const res = await handoff(harness, handoffPayload(geo, 'ORD-5', {
    destinationLocationId: String(geo.inactiveCity._id),
  }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /inactive/i);
});

it('an unknown (but well-formed) location id is stored as null, never as an orphan reference', async () => {
  const orphan = '507f1f77bcf86cd799439011';
  const res = await handoff(harness, handoffPayload(geo, 'ORD-6', {
    destinationLocationId: orphan, pickupLocationId: orphan,
  }));
  assert.equal(res.status, 201);
  const delivery = await harness.models.Delivery.findOne({ orderId: 'ORD-6' });
  assert.equal(delivery.destination.locationId, null);
  assert.equal(delivery.origin.locationId, null);
  assert.equal(delivery.destination.cityName, geo.city.name, 'the text snapshot still carries the address');
});



it('the handoff is only reachable with a service credential', async () => {
  const anonymous = await harness.request('/internal/delivery/request', {
    method: 'POST', body: handoffPayload(geo, 'ORD-7'), unsigned: true,
  });
  assert.equal(anonymous.status, 403, 'a direct caller with no cluster credential is refused');

  const forged = await harness.request('/internal/delivery/request', {
    method: 'POST', body: handoffPayload(geo, 'ORD-7'), internal: 'gateway', headers: { 'x-internal-token': 'forged' },
  });
  assert.equal(forged.status, 403, 'a wrong token is refused even when the caller name is known');

  const asDelivery = await harness.request('/internal/delivery/request', {
    method: 'POST', body: handoffPayload(geo, 'ORD-7'), internal: 'unknown-caller',
  });
  assert.equal(asDelivery.status, 403, 'a caller with no issued credential is refused');

  assert.equal(await harness.models.DeliveryRequest.countDocuments({ orderId: 'ORD-7' }), 0, 'no request slipped through');
});

it('a buyer cannot create a delivery request directly', async () => {
  const res = await harness.request('/delivery/request', {
    method: 'POST', as: harness.actors.buyer, body: handoffPayload(geo, 'ORD-8'),
  });
  assert.equal(res.status, 404, 'the public surface does not expose request creation at all');
  assert.equal(await harness.models.DeliveryRequest.countDocuments({ orderId: 'ORD-8' }), 0);
});

it('a COD delivery carries the proof rule and its amount', async () => {
  await createDelivery(harness, geo, 'ORD-9', { paymentMethod: 'COD', paymentAmount: 750 });
  const delivery = await harness.models.Delivery.findOne({ orderId: 'ORD-9' });
  assert.equal(delivery.paymentMethod, 'COD');
  assert.equal(delivery.paymentAmount, 750);
  assert.equal(delivery.proofRules.requireCodConfirmation, true);
});
