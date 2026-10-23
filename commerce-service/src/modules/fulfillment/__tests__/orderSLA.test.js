const test = require('node:test');
const assert = require('node:assert');
const orderSLAService = require('../services/orderSLA.service');
const orderSLARepository = require('../repositories/orderSLA.repository');
const orderRepository = require('../repositories/orders.repository');

const mockSession = {
  startTransaction: () => {},
  commitTransaction: () => {},
  abortTransaction: () => {},
  endSession: () => {},
};

// The gateway stamps `id` on req.user — never `_id`.
const adminActor = { id: 'admin1', role: 'ADMIN' };
const sellerActor = { id: 'seller1', role: 'SELLER' };

const orderOwnedBySeller = {
  _id: 'order1',
  status: 'PROCESSING',
  sellerId: 'seller1',
  buyerId: 'buyer1',
};

test('OrderSLAService', async t => {
  const originalStartSession = require('mongoose').startSession;

  await t.test('setSLA sets deadline for order', async () => {
    const mockOrder = { _id: 'order1', status: 'PENDING', sellerId: 'seller1' };
    const mockSLA = { _id: 'sla1', orderId: 'order1', stateName: 'PROCESSING', durationHours: 24 };

    orderRepository.findById = () => Promise.resolve(mockOrder);
    orderSLARepository.create = () => Promise.resolve(mockSLA);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderSLAService.setSLA(
      'order1',
      'PROCESSING',
      24,
      { userId: 'user1', actor: sellerActor }
    );

    assert.strictEqual(result._id, 'sla1');
    assert.strictEqual(result.durationHours, 24);
  });

  await t.test('setSLA rejects a non-positive duration', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    await assert.rejects(
      () => orderSLAService.setSLA('order1', 'PROCESSING', 0, { userId: 'u1', actor: sellerActor }),
      (err) => err.statusCode === 400
    );
  });

  await t.test('setSLA refuses an actor who is not a party to the order', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    await assert.rejects(
      () => orderSLAService.setSLA(
        'order1',
        'PROCESSING',
        24,
        { userId: 'x', actor: { id: 'stranger', role: 'BUYER' } }
      ),
      (err) => err.statusCode === 403
    );
  });

  await t.test('createBreach flags the existing SLA of the order', async () => {
    const existing = {
      _id: 'sla1',
      orderId: 'order1',
      stateName: 'PROCESSING',
      durationHours: 24,
      deadline: new Date(),
      breached: false,
    };

    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(existing);
    orderSLARepository.update = (_id, data) => Promise.resolve({ ...existing, ...data });
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderSLAService.createBreach(
      'order1',
      { reason: 'Dispatch missed' },
      { userId: 'admin1', actor: adminActor }
    );

    assert.strictEqual(result.breached, true);
    assert.strictEqual(result.breachReason, 'Dispatch missed');
    assert.strictEqual(result.breachedBy, 'admin1');
    assert.strictEqual(result.breachSource, 'MANUAL');
    assert(result.breachedAt instanceof Date);
  });

  await t.test('createBreach creates a record when the order has no SLA', async () => {
    let created = null;

    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(null);
    orderSLARepository.create = (data) => {
      created = data;
      return Promise.resolve(data);
    };
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderSLAService.createBreach(
      'order1',
      { reason: 'Upheld dispute' },
      { userId: 'admin1', actor: adminActor }
    );

    assert.strictEqual(result.breached, true);
    assert.strictEqual(result.breachReason, 'Upheld dispute');
    assert.strictEqual(result.breachSource, 'MANUAL');
    assert.strictEqual(created.orderId, 'order1');
  });

  await t.test('createBreach requires a reason', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    await assert.rejects(
      () => orderSLAService.createBreach('order1', { reason: '   ' }, { userId: 'admin1', actor: adminActor }),
      (err) => err.statusCode === 400
    );
  });

  await t.test('createBreach 404s for an unknown order', async () => {
    orderRepository.findById = () => Promise.resolve(null);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    await assert.rejects(
      () => orderSLAService.createBreach('nope', { reason: 'x' }, { userId: 'admin1', actor: adminActor }),
      (err) => err.statusCode === 404
    );
  });

  await t.test('createBreach refuses a non-admin actor', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    await assert.rejects(
      () => orderSLAService.createBreach('order1', { reason: 'x' }, { userId: 'seller1', actor: sellerActor }),
      (err) => err.statusCode === 403
    );
  });

  await t.test('checkSLACompliance returns compliant when within deadline', async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 12);
    const mockSLA = { _id: 'sla1', deadline: futureDate, durationHours: 24 };

    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.checkSLACompliance('order1', { actor: sellerActor });

    assert.strictEqual(result.compliant, true);
    assert.strictEqual(result.breached, false);
  });

  await t.test('checkSLACompliance returns non-compliant when deadline passed', async () => {
    const pastDate = new Date();
    pastDate.setHours(pastDate.getHours() - 1);
    const mockSLA = { _id: 'sla1', deadline: pastDate, durationHours: 24 };

    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.checkSLACompliance('order1', { actor: sellerActor });

    assert.strictEqual(result.compliant, false);
    assert.strictEqual(result.breached, true);
  });

  await t.test('checkSLACompliance honours a breach recorded against the SLA', async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 12);
    const mockSLA = {
      _id: 'sla1',
      deadline: futureDate,
      durationHours: 24,
      breached: true,
      breachReason: 'Upheld dispute',
    };

    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.checkSLACompliance('order1', { actor: sellerActor });

    // The deadline has not passed, but the breach was pushed in by hand.
    assert.strictEqual(result.compliant, false);
    assert.strictEqual(result.breached, true);
    assert.strictEqual(result.breachReason, 'Upheld dispute');
  });

  await t.test('checkSLACompliance returns compliant when no SLA set', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(null);

    const result = await orderSLAService.checkSLACompliance('order1', { actor: sellerActor });

    assert.strictEqual(result.compliant, true);
    assert.strictEqual(result.reason, 'No SLA set');
  });

  await t.test('checkSLACompliance refuses a caller who is not a party to the order', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(null);

    await assert.rejects(
      () => orderSLAService.checkSLACompliance('order1', { actor: { id: 'stranger', role: 'BUYER' } }),
      (err) => err.statusCode === 403
    );
  });

  await t.test('getSLAStatus returns status details', async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 12);
    const mockSLA = { _id: 'sla1', stateName: 'PROCESSING', deadline: futureDate, durationHours: 24 };

    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.getSLAStatus('order1', { actor: sellerActor });

    assert.strictEqual(result.stateName, 'PROCESSING');
    assert.strictEqual(result.breached, false);
    assert(result.percentComplete >= 0);
  });

  await t.test('getSLAStatus returns null if no SLA', async () => {
    orderRepository.findById = () => Promise.resolve(orderOwnedBySeller);
    orderSLARepository.findByOrderId = () => Promise.resolve(null);

    const result = await orderSLAService.getSLAStatus('order1', { actor: sellerActor });

    assert.strictEqual(result, null);
  });

  await t.test('getSLABreaches returns SLA breaches', async () => {
    const mockBreaches = [
      { _id: 'sla1', orderId: 'order1', deadline: new Date() },
      { _id: 'sla2', orderId: 'order2', deadline: new Date() },
    ];

    orderSLARepository.markOverdue = () => Promise.resolve({ modifiedCount: 2 });
    orderSLARepository.find = () => Promise.resolve(mockBreaches);

    const result = await orderSLAService.getSLABreaches('seller1', 'week');

    assert.strictEqual(result.length, 2);
  });

  await t.test('getSLABreaches scopes a seller to their own orders', async () => {
    let capturedFilter = null;

    orderSLARepository.markOverdue = () => Promise.resolve({ modifiedCount: 0 });
    orderRepository.findIdsBySellerOrShop = () => Promise.resolve(['order1', 'order2']);
    orderSLARepository.find = (query) => {
      capturedFilter = query.filter;
      return Promise.resolve([]);
    };

    await orderSLAService.getSLABreaches('seller1', 'week', { scopeToSeller: true });

    assert.deepStrictEqual(capturedFilter.orderId, { $in: ['order1', 'order2'] });
  });

  await t.test('getSLABreaches returns nothing for a seller with no orders', async () => {
    orderSLARepository.markOverdue = () => Promise.resolve({ modifiedCount: 0 });
    orderRepository.findIdsBySellerOrShop = () => Promise.resolve([]);
    orderSLARepository.find = () => Promise.resolve([{ _id: 'sla1' }]);

    const result = await orderSLAService.getSLABreaches('seller1', 'week', {
      scopeToSeller: true,
    });

    // An empty id list must never turn into "match every breach".
    assert.deepStrictEqual(result, []);
  });

  await t.test('getSLABreaches does not scope an admin to a seller', async () => {
    let capturedFilter = null;

    orderSLARepository.markOverdue = () => Promise.resolve({ modifiedCount: 0 });
    orderSLARepository.find = (query) => {
      capturedFilter = query.filter;
      return Promise.resolve([]);
    };

    await orderSLAService.getSLABreaches('admin1', 'week', { scopeToSeller: false });

    assert.strictEqual(capturedFilter.orderId, undefined);
  });

  require('mongoose').startSession = originalStartSession;
});
