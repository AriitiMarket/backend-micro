const test = require('node:test');
const assert = require('node:assert');
const orderPriorityService = require('../services/orderPriority.service');
const orderPriorityRepository = require('../repositories/orderPriority.repository');
const orderRepository = require('../repositories/orders.repository');

// Mock implementations
const mockSession = {
  startTransaction: () => {},
  commitTransaction: () => {},
  abortTransaction: () => {},
  endSession: () => {},
};

let startSessionMock;

test('OrderPriorityService', async t => {
  // Setup mocks before each test
  const originalStartSession = require('mongoose').startSession;

  await t.test('setPriority creates priority for order', async () => {
    const mockOrder = { _id: 'order1', status: 'PROCESSING' };
    const mockPriority = { _id: 'pri1', orderId: 'order1', priority: 'VIP' };

    // Mock the repository methods
    orderPriorityRepository.findByOrderId = () => Promise.resolve(null);
    orderPriorityRepository.create = () => Promise.resolve(mockPriority);
    orderRepository.findById = () => Promise.resolve(mockOrder);

    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderPriorityService.setPriority('order1', 'VIP', 'VIP customer', { userId: 'admin1' });

    assert.strictEqual(result._id, 'pri1');
    assert.strictEqual(result.priority, 'VIP');
  });

  await t.test('getPriority returns priority or NORMAL default', async () => {
    orderPriorityRepository.findByOrderId = () => Promise.resolve(null);

    const result = await orderPriorityService.getPriority('order1');

    assert.strictEqual(result.priority, 'NORMAL');
    assert.strictEqual(result.orderId, 'order1');
  });

  await t.test('getVIPOrders retrieves VIP and URGENT orders', async () => {
    const mockVIPOrders = [
      { _id: 'pri1', orderId: 'order1', priority: 'VIP' },
      { _id: 'pri2', orderId: 'order2', priority: 'URGENT' },
    ];

    orderPriorityRepository.findByPriority = () => Promise.resolve(mockVIPOrders);

    const result = await orderPriorityService.getVIPOrders();

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].priority, 'VIP');
  });

  await t.test('resetPriority sets priority to NORMAL', async () => {
    const mockPriority = { _id: 'pri1', priority: 'VIP' };
    const resetPriority = { _id: 'pri1', priority: 'NORMAL' };

    orderPriorityRepository.findByOrderId = () => Promise.resolve(mockPriority);
    orderPriorityRepository.update = () => Promise.resolve(resetPriority);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderPriorityService.resetPriority('order1', { userId: 'admin1' });

    assert.strictEqual(result.priority, 'NORMAL');
  });

  await t.test('getPriorityStats returns counts by priority', async () => {
    const mockStats = {
      total: 100,
      byPriority: { NORMAL: 75, HIGH: 15, VIP: 8, URGENT: 2 },
    };

    orderPriorityRepository.getStats = () => Promise.resolve(mockStats);

    const result = await orderPriorityService.getPriorityStats();

    assert.strictEqual(result.total, 100);
    assert.strictEqual(result.byPriority.VIP, 8);
  });

  // Restore mocks
  require('mongoose').startSession = originalStartSession;
});
