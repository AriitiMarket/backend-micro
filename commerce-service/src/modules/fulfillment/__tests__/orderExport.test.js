const test = require('node:test');
const assert = require('node:assert');
const orderExportService = require('../services/orderExport.service');
const orderRepository = require('../repositories/orders.repository');

test('OrderExportService', async t => {
  await t.test('exportOrdersAsCSV exports orders as CSV', async () => {
    const mockOrders = [
      {
        _id: 'order1',
        createdAt: new Date('2024-01-01'),
        user: { name: 'John Doe' },
        totalPrice: 100,
        status: 'COMPLETED',
        cart: [{ productId: 'p1' }],
      },
    ];

    orderRepository.find = () => Promise.resolve(mockOrders);

    const result = await orderExportService.exportOrdersAsCSV({});

    assert(result.filename.match(/^orders_\d+\.csv$/));
    assert.strictEqual(result.mimeType, 'text/csv');
    assert(result.content.includes('Order ID'));
    assert(result.content.includes('order1'));
  });

  await t.test('exportOrdersAsCSV throws error if no orders', async () => {
    orderRepository.find = () => Promise.resolve([]);

    try {
      await orderExportService.exportOrdersAsCSV({});
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'No orders to export');
    }
  });

  await t.test('exportOrdersAsPDF exports orders as PDF', async () => {
    const mockOrders = [
      { _id: 'order1', totalPrice: 100, status: 'COMPLETED' },
    ];

    orderRepository.find = () => Promise.resolve(mockOrders);

    const result = await orderExportService.exportOrdersAsPDF({});

    assert(result.filename.match(/^orders_\d+\.pdf$/));
    assert.strictEqual(result.mimeType, 'application/pdf');
    assert.strictEqual(result.data.length, 1);
  });

  await t.test('exportSingleOrderAsJSON exports single order', async () => {
    const mockOrder = {
      _id: 'order1',
      totalPrice: 100,
      status: 'COMPLETED',
      toObject: () => ({ _id: 'order1', totalPrice: 100 }),
    };

    orderRepository.findById = () => Promise.resolve(mockOrder);

    const result = await orderExportService.exportSingleOrderAsJSON('order1');

    assert.strictEqual(result.filename, 'order_order1.json');
    assert.strictEqual(result.mimeType, 'application/json');
    assert(result.content.includes('order1'));
  });

  await t.test('exportSingleOrderAsJSON throws error if not found', async () => {
    orderRepository.findById = () => Promise.resolve(null);

    try {
      await orderExportService.exportSingleOrderAsJSON('invalid');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Order not found');
    }
  });
});
