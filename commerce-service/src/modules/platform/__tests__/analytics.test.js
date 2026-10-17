const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, beforeEach, after, afterEach } = require('node:test');

const DB_URL = process.env.MONGODB_URI_TEST
  || 'mongodb://localhost:27017/ariti_commerce_test_analytics';
process.env.MONGODB_URI = DB_URL;

const COLLECTIONS = ['orders', 'shops', 'products', 'payments', 'stockmovements', 'disputes'];

const ORDER_STATUSES = {
  PROCESSING: 'Processing',
  CONFIRMED: 'Confirmed',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUND_SUCCESS: 'Refund Success',
};

const PAYMENT_STATUSES = { CONFIRMED: 'CONFIRMED', REFUNDED: 'REFUNDED', PENDING: 'PENDING' };

let Order, Shop, Product;
let analyticsService;
let identityClient, deliveryClient;

function stubClients() {
  identityClient.countUsers = async () => ({ status: 200, body: { counts: { total: 0, sellers: 0 } } });
  deliveryClient.getInternalOperationsDashboard = async () => ({
    status: 200,
    body: { dashboard: { providers: { total: 0, available: 0 }, total: 0, delivered: 0, failed: 0, avgDeliveryTime: 0 } },
  });
}

function orderDoc(overrides = {}) {
  return {
    buyerId: 'buyer-1',
    user: { name: 'Buyer', email: 'b@test.local' },
    cart: [{ _id: 'prod-1', name: 'Widget', quantity: 2, price: 100, unitPrice: 100 }],
    subtotal: 200,
    shippingFee: 0,
    currency: 'ETB',
    totalPrice: 200,
    status: ORDER_STATUSES.PROCESSING,
    paymentStatus: PAYMENT_STATUSES.PENDING,
    sellerId: 'seller-a',
    sellerShipments: [{ sellerId: 'seller-a', shopId: 'shop-a', items: [], subtotal: 200 }],
    createdAt: new Date('2026-01-10'),
    updatedAt: new Date('2026-01-10'),
    ...overrides,
  };
}

before(async () => {
  await mongoose.connect(DB_URL);
  Order = require('../../fulfillment/models/Orders');
  Shop = require('../../selling/models/Shops');
  Product = require('../../catalog/models/Products');
  analyticsService = require('../services/analytics.service');
  identityClient = require('../../../app/clients/identity.client').identityClient;
  deliveryClient = require('../../../app/clients/delivery.client').deliveryClient;
  stubClients();
});

beforeEach(async () => {
  await Promise.all(COLLECTIONS.map((name) => mongoose.connection.db.collection(name).deleteMany({})));
  await Promise.all([Order.init(), Shop.init(), Product.init()]);
  stubClients();
});

afterEach(async () => {
  await Promise.all(COLLECTIONS.map((name) => mongoose.connection.db.collection(name).deleteMany({})));
});

after(async () => {
  await mongoose.connection.close();
});

describe('Analytics revenue accounting', () => {
  it('counts only delivered/completed orders toward gross revenue', async () => {
    await Order.create([
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 100, sellerId: 'seller-a' }),
      orderDoc({ status: ORDER_STATUSES.CANCELLED, totalPrice: 500, sellerId: 'seller-a' }),
      orderDoc({ status: ORDER_STATUSES.PROCESSING, totalPrice: 300, sellerId: 'seller-a' }),
      orderDoc({ status: ORDER_STATUSES.REFUND_SUCCESS, totalPrice: 200, sellerId: 'seller-a' }),
    ]);

    const stats = await analyticsService.getStats('2026-01-01', '2026-02-01', { sellerId: 'seller-a' });
    assert.strictEqual(stats.totalOrders, 4);
    assert.strictEqual(stats.deliveredOrders, 1);
    assert.strictEqual(stats.cancelledOrders, 1);
    // Gross revenue counts only the delivered order (100), not cancelled (500), processing (300), or refunded (200).
    assert.strictEqual(stats.grossSales, 100);
    assert.strictEqual(stats.refunds, 200);
    assert.strictEqual(stats.netSales, -100);
  });

  it('treats DELIVERED as revenue (legacy alias spellings normalize on read)', async () => {
    await Order.create([
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 100, sellerId: 'seller-a' }),
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 50, sellerId: 'seller-a' }),
    ]);
    const stats = await analyticsService.getStats('2026-01-01', '2026-02-01', { sellerId: 'seller-a' });
    assert.strictEqual(stats.deliveredOrders, 2);
    assert.strictEqual(stats.grossSales, 150);
  });

  it('returns zeros for an empty dataset without misleading totals', async () => {
    const stats = await analyticsService.getStats('2026-01-01', '2026-02-01', { sellerId: 'seller-a' });
    assert.strictEqual(stats.totalOrders, 0);
    assert.strictEqual(stats.grossSales, 0);
    assert.strictEqual(stats.refunds, 0);
    assert.strictEqual(stats.netSales, 0);
    assert.strictEqual(stats.avgOrderValue, 0);
  });

  it('applies date filters so out-of-period orders are excluded', async () => {
    await Order.create([
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 100, sellerId: 'seller-a', createdAt: new Date('2026-01-10') }),
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 100, sellerId: 'seller-a', createdAt: new Date('2026-03-10') }),
    ]);
    const stats = await analyticsService.getStats('2026-01-01', '2026-01-31', { sellerId: 'seller-a' });
    assert.strictEqual(stats.totalOrders, 1);
    assert.strictEqual(stats.grossSales, 100);
  });
});

describe('Seller-scoped reporting (tenant isolation)', () => {
  it('getSellerStats returns only the authenticated seller\'s data', async () => {
    await Shop.create([
      { name: 'Shop A', email: 'a@test.local', address: '1 A', ownerId: 'seller-a', status: 'APPROVED', avatar: { public_id: 'a', url: '/a.png' } },
      { name: 'Shop B', email: 'b@test.local', address: '1 B', ownerId: 'seller-b', status: 'APPROVED', avatar: { public_id: 'b', url: '/b.png' } },
    ]);
    await Order.create([
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 100, sellerId: 'seller-a' }),
      orderDoc({ status: ORDER_STATUSES.DELIVERED, totalPrice: 999, sellerId: 'seller-b' }),
    ]);

    const statsA = await analyticsService.getSellerStats('2026-01-01', '2026-02-01', 'seller-a');
    assert.strictEqual(statsA.error, undefined);
    assert.strictEqual(statsA.sellerId, 'seller-a');
    assert.strictEqual(statsA.totalOrders, 1);
    assert.strictEqual(statsA.grossSales, 100);

    const statsB = await analyticsService.getSellerStats('2026-01-01', '2026-02-01', 'seller-b');
    assert.strictEqual(statsB.totalOrders, 1);
    assert.strictEqual(statsB.grossSales, 999);
  });

  it('getSellerStats requires a sellerId', async () => {
    const result = await analyticsService.getSellerStats('2026-01-01', '2026-02-01', null);
    assert.strictEqual(result.error, 'sellerId is required');
  });
});
