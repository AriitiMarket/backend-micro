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

test('OrderSLAService', async t => {
  const originalStartSession = require('mongoose').startSession;

  await t.test('setSLA sets deadline for order', async () => {
    const mockOrder = { _id: 'order1', status: 'PENDING' };
    const mockSLA = { _id: 'sla1', orderId: 'order1', stateName: 'PROCESSING', durationHours: 24 };

    orderRepository.findById = () => Promise.resolve(mockOrder);
    orderSLARepository.create = () => Promise.resolve(mockSLA);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderSLAService.setSLA('order1', 'PROCESSING', 24, { userId: 'user1' });

    assert.strictEqual(result._id, 'sla1');
    assert.strictEqual(result.durationHours, 24);
  });

  await t.test('checkSLACompliance returns compliant when within deadline', async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 12);
    const mockSLA = { _id: 'sla1', deadline: futureDate, durationHours: 24 };

    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.checkSLACompliance('order1');

    assert.strictEqual(result.compliant, true);
    assert.strictEqual(result.breached, false);
  });

  await t.test('checkSLACompliance returns non-compliant when deadline passed', async () => {
    const pastDate = new Date();
    pastDate.setHours(pastDate.getHours() - 1);
    const mockSLA = { _id: 'sla1', deadline: pastDate, durationHours: 24 };

    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.checkSLACompliance('order1');

    assert.strictEqual(result.compliant, false);
    assert.strictEqual(result.breached, true);
  });

  await t.test('checkSLACompliance returns compliant when no SLA set', async () => {
    orderSLARepository.findByOrderId = () => Promise.resolve(null);

    const result = await orderSLAService.checkSLACompliance('order1');

    assert.strictEqual(result.compliant, true);
    assert.strictEqual(result.reason, 'No SLA set');
  });

  await t.test('getSLAStatus returns status details', async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 12);
    const mockSLA = { _id: 'sla1', stateName: 'PROCESSING', deadline: futureDate, durationHours: 24 };

    orderSLARepository.findByOrderId = () => Promise.resolve(mockSLA);

    const result = await orderSLAService.getSLAStatus('order1');

    assert.strictEqual(result.stateName, 'PROCESSING');
    assert.strictEqual(result.breached, false);
    assert(result.percentComplete >= 0);
  });

  await t.test('getSLAStatus returns null if no SLA', async () => {
    orderSLARepository.findByOrderId = () => Promise.resolve(null);

    const result = await orderSLAService.getSLAStatus('order1');

    assert.strictEqual(result, null);
  });

  await t.test('getSLABreaches returns SLA breaches', async () => {
    const mockBreaches = [
      { _id: 'sla1', orderId: 'order1', deadline: new Date() },
      { _id: 'sla2', orderId: 'order2', deadline: new Date() },
    ];

    orderSLARepository.find = () => Promise.resolve(mockBreaches);

    const result = await orderSLAService.getSLABreaches('seller1', 'week');

    assert.strictEqual(result.length, 2);
  });

  require('mongoose').startSession = originalStartSession;
});
