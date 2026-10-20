/**
 * Seller Allocation Ledger — unit tests.
 *
 * Runs against a dedicated test DB (ariti_commerce_test_allocations) so it can
 * run in parallel with the other suites. Uses Node's built-in test runner.
 *
 * Covers:
 *   - computeOrderAllocations: one seller, multiple sellers, rounding
 *   - allocateOrder: idempotency (duplicate calls don't duplicate rows/money)
 *   - getSellerAllocations / getOrderAllocations scoping
 *   - settleAllocation: settled vs pending, partial, over-settlement rejected
 *   - refundAllocation: reduces net payable
 *   - Reconciliation: seller netPayable + platform commission == buyer payment
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_allocations$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_allocations';

let Order, SellerAllocation, allocationService, sellerAllocationRepository, ORDER_STATUSES;

before(async () => {
  await mongoose.connect(DB_URL);
  ORDER_STATUSES = require('../constants/orderStatuses').ORDER_STATUSES;
  Order = require('../models/Orders');
  SellerAllocation = require('../models/SellerAllocation');
  await Promise.all([Order.deleteMany({}), SellerAllocation.deleteMany({}), require("../models/Settlement").deleteMany({})]);
  await Promise.all([Order.init(), SellerAllocation.init()]);
  allocationService = require('../services/allocation.service');
  sellerAllocationRepository = require('../repositories/sellerAllocation.repository');
});

afterEach(async () => {
  await Promise.all([Order.deleteMany({}), SellerAllocation.deleteMany({}), require("../models/Settlement").deleteMany({})]);
});

after(async () => { await mongoose.connection.close(); });

const oid = () => new mongoose.Types.ObjectId().toString();

function moneyOrder(overrides = {}) {
  return Order.create({
    cart: [
      { _id: 'p-1', productId: 'p-1', name: 'Widget', quantity: 2, qty: 2, discountPrice: 100, price: 100, subtotal: 200 },
    ],
    user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' },
    buyerId: 'buyer-1',
    subtotal: 200,
    shippingFee: 6,
    currency: 'ETB',
    totalPrice: 206,
    paymentStatus: 'CONFIRMED',
    status: ORDER_STATUSES.CONFIRMED,
    sellerId: 'seller-1',
    sellerShipments: [
      { sellerId: 'seller-1', shopId: 'shop-1', shopName: 'Shop 1', items: [{ name: 'Widget', quantity: 2, subtotal: 200 }], subtotal: 200 },
    ],
    ...overrides,
  });
}

async function multiSellerOrder(overrides = {}) {
  // One buyer order = two Order documents (one per seller) sharing orderGroupId.
  // Each Order doc carries ITS OWN shipping (computeShipping(shipment.subtotal)):
  // seller-1: subtotal 100 + shipping 3 = 103; seller-2: subtotal 200 + shipping 6 = 206.
  // Buyer total = 309.
  const groupId = 'group-abc';
  const s1 = await Order.create({
    cart: [{ _id: 'p-1', productId: 'p-1', name: 'Widget', quantity: 1, qty: 1, discountPrice: 100, price: 100, subtotal: 100 }],
    user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' },
    buyerId: 'buyer-1',
    subtotal: 100,
    shippingFee: 3,
    currency: 'ETB',
    totalPrice: 103,
    paymentStatus: 'CONFIRMED',
    status: ORDER_STATUSES.CONFIRMED,
    orderGroupId: groupId,
    sellerId: 'seller-1',
    sellerShipments: [
      { sellerId: 'seller-1', shopId: 'shop-1', shopName: 'Shop 1', items: [{ name: 'Widget', quantity: 1, subtotal: 100 }], subtotal: 100 },
    ],
  });
  const s2 = await Order.create({
    cart: [{ _id: 'p-2', productId: 'p-2', name: 'Gadget', quantity: 1, qty: 1, discountPrice: 200, price: 200, subtotal: 200 }],
    user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' },
    buyerId: 'buyer-1',
    subtotal: 200,
    shippingFee: 6,
    currency: 'ETB',
    totalPrice: 206,
    paymentStatus: 'CONFIRMED',
    status: ORDER_STATUSES.CONFIRMED,
    orderGroupId: groupId,
    sellerId: 'seller-2',
    sellerShipments: [
      { sellerId: 'seller-2', shopId: 'shop-2', shopName: 'Shop 2', items: [{ name: 'Gadget', quantity: 1, subtotal: 200 }], subtotal: 200 },
    ],
  });
  return { order1: s1, order2: s2, orderGroupId: groupId };
}
describe('computeOrderAllocations', () => {
  it('one seller: gross, commission, net payable reconcile to buyer payment', async () => {
    const order = await moneyOrder();
    const allocs = allocationService.computeOrderAllocations(order);
    assert.strictEqual(allocs.length, 1);
    const a = allocs[0];
    assert.strictEqual(a.grossSubtotal, 200);
    assert.strictEqual(a.shippingFee, 6);
    assert.strictEqual(a.platformCommission, 20);
    assert.strictEqual(a.netPayable, 186);
    assert.strictEqual(a.netPayable + a.platformCommission, 206);
  });

  it('multiple sellers in one buyer order: each allocation independent and sums to buyer total', async () => {
    const { order1, order2, orderGroupId } = await multiSellerOrder();
    const allocs1 = allocationService.computeOrderAllocations(order1);
    const allocs2 = allocationService.computeOrderAllocations(order2);
    const allocs = [...allocs1, ...allocs2];
    assert.strictEqual(allocs.length, 2);
    const bySeller = new Map(allocs.map((a) => [a.sellerId, a]));
    const s1 = bySeller.get('seller-1');
    const s2 = bySeller.get('seller-2');
    assert.strictEqual(s1.platformCommission, 10);
    assert.strictEqual(s1.netPayable, 93);
    assert.strictEqual(s2.platformCommission, 20);
    assert.strictEqual(s2.netPayable, 186);
    const sumNet = allocs.reduce((t, a) => t + a.netPayable, 0);
    const sumComm = allocs.reduce((t, a) => t + a.platformCommission, 0);
    assert.strictEqual(sumNet + sumComm, 309);
    assert.strictEqual(s1.orderGroupId, orderGroupId);
    assert.strictEqual(s2.orderGroupId, orderGroupId);
  });

  it('rounding: odd commission splits are rounded to 2dp consistently', async () => {
    const order = await moneyOrder({
      subtotal: 133,
      shippingFee: 4,
      totalPrice: 137,
      sellerShipments: [{ sellerId: 'seller-1', shopId: 'shop-1', items: [{ subtotal: 133 }], subtotal: 133 }],
    });
    const [a] = allocationService.computeOrderAllocations(order);
    assert.strictEqual(a.platformCommission, 13.3);
    assert.strictEqual(a.netPayable, 123.7);
  });
});

describe('allocateOrder (idempotency + persistence)', () => {
  it('creates exactly one allocation row per seller even when called twice', async () => {
    const { order1 } = await multiSellerOrder();
    const first = await allocationService.allocateOrder(order1);
    const second = await allocationService.allocateOrder(order1);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
    const rows = await sellerAllocationRepository.findByOrder(String(order1._id));
    assert.strictEqual(rows.length, 1, 'duplicate allocation must not create extra rows');
    assert.strictEqual(rows[0].sellerId, 'seller-1');
    assert.strictEqual(rows[0].settledAmount, 0);
    assert.strictEqual(rows[0].status, 'PENDING');
  });

  it('getOrderAllocations works by order id and by order group id', async () => {
    const { order1, order2, orderGroupId } = await multiSellerOrder();
    await allocationService.allocateOrder(order1);
    await allocationService.allocateOrder(order2);
    const byOrder = await allocationService.getOrderAllocations(String(order1._id));
    assert.strictEqual(byOrder.length, 1);
    assert.strictEqual(byOrder[0].sellerId, 'seller-1');
    const byGroup = await allocationService.getOrderAllocations(orderGroupId);
    assert.strictEqual(byGroup.length, 2);
  });

  it('seller-scoped read returns only that seller\'s rows', async () => {
    const { order1, order2 } = await multiSellerOrder();
    await allocationService.allocateOrder(order1);
    await allocationService.allocateOrder(order2);
    const s1 = await allocationService.getSellerAllocations('seller-1');
    const s2 = await allocationService.getSellerAllocations('seller-2');
    assert.strictEqual(s1.length, 1);
    assert.strictEqual(s1[0].sellerId, 'seller-1');
    assert.strictEqual(s2.length, 1);
    assert.strictEqual(s2[0].sellerId, 'seller-2');
  });
});

describe('settleAllocation + refundAllocation', () => {
  it('settlement moves settledAmount up and marks SETTLED when fully covered', async () => {
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    assert.strictEqual(alloc.status, 'PENDING');
    assert.strictEqual(alloc.pendingAmount, 186);

    const result = await allocationService.settleAllocation(alloc._id, {
      amount: 186, reference: 'payout-1', provider: 'manual', reason: 'Weekly payout',
      actor: { id: 'admin-1', role: 'ADMIN' },
    });
    console.error("DBG result keys:", result && result.allocation && Object.keys(result.allocation), "settled:", result && result.allocation && result.allocation.settledAmount, "raw:", JSON.stringify(result && result.allocation));
    assert.strictEqual(result.allocation.settledAmount, 186);
    assert.strictEqual(result.allocation.pendingAmount, 0);
    assert.strictEqual(result.allocation.status, 'SETTLED');
    assert.strictEqual(result.settlement.amount, 186);
    assert.strictEqual(result.settlement.reference, 'payout-1');
  });

  it('partial settlement leaves PARTIALLY_SETTLED and pending', async () => {
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    await allocationService.settleAllocation(alloc._id, { amount: 100, reference: 'p-1', actor: { id: 'admin-1', role: 'ADMIN' } });
    const row = await sellerAllocationRepository.findById(alloc._id);
    assert.strictEqual(row.status, 'PARTIALLY_SETTLED');
    assert.strictEqual(row.pendingAmount, 86);
  });

  it('cannot settle more than net payable', async () => {
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    await assert.rejects(
      () => allocationService.settleAllocation(alloc._id, { amount: 999, reference: 'p-x', actor: { id: 'admin-1', role: 'ADMIN' } }),
      (err) => err.statusCode === 400 && /exceeds net payable/.test(err.message)
    );
    const row = await sellerAllocationRepository.findById(alloc._id);
    assert.strictEqual(row.settledAmount, 0);
  });

  it('refund reduces net payable and pending (with commission reversal)', async () => {
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    const updated = await allocationService.refundAllocation(alloc._id, { amount: 50, reason: 'partial', actor: { id: 'admin-1', role: 'ADMIN' } });
    // netPayable = 200 + 6 - 20(commission) = 186
    // Commission reversed on refund: 50 * 10% = 5, new commission = 15
    // netPayable = 200 + 6 - 15 - 50(refund) = 141
    assert.strictEqual(updated.netPayable, 141);
    assert.strictEqual(updated.pendingAmount, 141);
    assert.strictEqual(updated.platformCommission, 15); // Commission was reversed
  });

  it('settlement reference cannot be reused for a second payout', async () => {
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    // First partial payout under reference 'p-again' (leaves room for more).
    await allocationService.settleAllocation(alloc._id, { amount: 50, reference: 'p-again', actor: { id: 'admin-1', role: 'ADMIN' } });
    // Reusing the same reference for another payout must hit the unique reference constraint.
    await assert.rejects(
      () => allocationService.settleAllocation(alloc._id, { amount: 100, reference: 'p-again', actor: { id: 'admin-1', role: 'ADMIN' } }),
      /duplicate key|E11000/
    );
    // Allocation must not have been double-changed by the failed attempt.
    const row = await sellerAllocationRepository.findById(alloc._id);
    assert.strictEqual(row.settledAmount, 50);
  });
});

