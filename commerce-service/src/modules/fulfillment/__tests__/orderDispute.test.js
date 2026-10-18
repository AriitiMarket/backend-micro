const test = require('node:test');
const assert = require('node:assert');
const orderDisputeService = require('../services/orderDispute.service');
const orderDisputeRepository = require('../repositories/orderDispute.repository');
const orderRepository = require('../repositories/orders.repository');

const mockSession = {
  startTransaction: () => {},
  commitTransaction: () => {},
  abortTransaction: () => {},
  endSession: () => {},
};

test('OrderDisputeService', async t => {
  const originalStartSession = require('mongoose').startSession;

  await t.test('createDispute creates dispute for order', async () => {
    const mockOrder = { _id: 'order1', status: 'COMPLETED' };
    const mockDispute = {
      _id: 'dispute1',
      orderId: 'order1',
      reason: 'Product not as described',
      status: 'OPEN',
    };

    orderRepository.findById = () => Promise.resolve(mockOrder);
    orderDisputeRepository.create = () => Promise.resolve(mockDispute);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderDisputeService.createDispute(
      'order1',
      'Product not as described',
      { images: ['img1'] },
      { userId: 'buyer1', role: 'BUYER' }
    );

    assert.strictEqual(result.status, 'OPEN');
  });

  await t.test('createDispute throws error if order not found', async () => {
    orderRepository.findById = () => Promise.resolve(null);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    try {
      await orderDisputeService.createDispute(
        'invalid',
        'Product not as described',
        {},
        { userId: 'buyer1', role: 'BUYER' }
      );
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Order not found');
    }
  });

  await t.test('updateDispute changes dispute status', async () => {
    const mockDispute = { _id: 'dispute1', status: 'OPEN' };
    const updatedDispute = { _id: 'dispute1', status: 'INVESTIGATING' };

    orderDisputeRepository.findById = () => Promise.resolve(mockDispute);
    orderDisputeRepository.update = () => Promise.resolve(updatedDispute);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    const result = await orderDisputeService.updateDispute(
      'dispute1',
      'INVESTIGATING',
      { notes: 'Reviewing' },
      { userId: 'admin1' }
    );

    assert.strictEqual(result.status, 'INVESTIGATING');
  });

  await t.test('updateDispute validates status', async () => {
    const mockDispute = { _id: 'dispute1', status: 'OPEN' };
    orderDisputeRepository.findById = () => Promise.resolve(mockDispute);
    require('mongoose').startSession = () => Promise.resolve(mockSession);

    try {
      await orderDisputeService.updateDispute(
        'dispute1',
        'INVALID_STATUS',
        {},
        { userId: 'admin1' }
      );
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Invalid status');
    }
  });

  await t.test('getDispute retrieves dispute by ID', async () => {
    const mockDispute = { _id: 'dispute1', reason: 'Product issue', status: 'OPEN' };
    orderDisputeRepository.findById = () => Promise.resolve(mockDispute);

    const result = await orderDisputeService.getDispute('dispute1');

    assert.strictEqual(result._id, 'dispute1');
  });

  await t.test('getDispute throws error if not found', async () => {
    orderDisputeRepository.findById = () => Promise.resolve(null);

    try {
      await orderDisputeService.getDispute('invalid');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Dispute not found');
    }
  });

  await t.test('getSellerDisputes returns disputes for seller', async () => {
    const mockDisputes = [
      { _id: 'dispute1', orderId: 'order1', status: 'OPEN' },
      { _id: 'dispute2', orderId: 'order2', status: 'INVESTIGATING' },
    ];

    orderDisputeRepository.find = () => Promise.resolve(mockDisputes);

    const result = await orderDisputeService.getSellerDisputes('seller1');

    assert.strictEqual(result.length, 2);
  });

  await t.test('getOpenDisputes retrieves non-resolved disputes', async () => {
    const mockDisputes = [
      { _id: 'dispute1', status: 'OPEN' },
      { _id: 'dispute2', status: 'INVESTIGATING' },
    ];

    orderDisputeRepository.find = () => Promise.resolve(mockDisputes);

    const result = await orderDisputeService.getOpenDisputes();

    assert.strictEqual(result.length, 2);
  });

  require('mongoose').startSession = originalStartSession;
});
