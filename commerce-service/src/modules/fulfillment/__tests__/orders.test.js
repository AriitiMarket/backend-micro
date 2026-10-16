/**
 * Orders State Machine & Lifecycle Tests
 *
 * Uses Node's built-in test runner (`node --test`).
 * Covers: normalizeStatus, canTransition, refund transition guards,
 * atomic cancel claim, claimPaymentConfirmation whitelist,
 * existsOwnedOrder cancellation exclusion, and payment↔order consistency
 * (via the payments service's status maps).
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

// Dedicated DB so this file can run in parallel with carts/wishlists suites
// (a shared `ariti_commerce_test` + dropDatabase raced across files).
const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_orders$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_orders';

let Order;
let Product;
let Payment;
let orderRepo;
let orderService;
let paymentService;
let paymentRepo;
let productRepository;
let ORDER_STATUSES;
let normalizeStatus;
let canTransition;

before(async () => {
  await mongoose.connect(DB_URL);
  ({ ORDER_STATUSES, normalizeStatus, canTransition } = require('../constants/orderStatuses'));
  Order = require('../models/Orders');
  Product = require('../../catalog/models/Products');
  Payment = require('../models/Payments');
  // deleteMany, not dropDatabase: drop can leave the DB in DatabaseDropPending
  // under parallel suite starts, failing subsequent ops. Pre-build indexes too
  // so the first create() doesn't pay index-build latency mid-test.
  await Promise.all([Order.deleteMany({}), Product.deleteMany({}), Payment.deleteMany({})]);
  await Promise.all([Order.init(), Product.init(), Payment.init()]);
  orderRepo = require('../repositories/orders.repository');
  orderService = require('../services/orders.service');
  paymentService = require('../services/payments.service');
  paymentRepo = require('../repositories/payments.repository');
  productRepository = require('../../catalog/repositories/products.repository');
});

// afterEach deleteMany (NOT dropDatabase): drop races parallel suite starts
// (DocumentNotFoundError mid-save / null reloadedOrder). deleteMany is
// per-collection and safe between sequential tests; each test seeds its own
// order/product so no cross-test data leaks into assertions.
afterEach(async () => {
  await Promise.all([Order.deleteMany({}), Product.deleteMany({}), Payment.deleteMany({})]);
});

after(async () => {
  await mongoose.connection.close();
});

const oid = () => new mongoose.Types.ObjectId().toString();

async function seedProduct(overrides = {}) {
  return Product.create({
    name: 'Order Test Product',
    description: 'A test product',
    category: 'Electronics',
    discountPrice: 100,
    originalPrice: 120,
    stock: 10,
    reserved: 0,
    images: ['img.jpg'],
    status: 'PUBLISHED',
    isActive: true,
    shopId: 'shop-1',
    shop: { _id: 'shop-1', name: 'Test Shop', status: 'APPROVED', showOnPublic: true },
    ratings: 4.5,
    ...overrides,
  });
}

async function seedOrder(overrides = {}) {
  const { _product, cartLine, ...rest } = overrides;
  const product = _product || (await seedProduct());
  const line = {
    _id: String(product._id),
    productId: String(product._id),
    name: product.name,
    quantity: 2,
    qty: 2,
    discountPrice: product.discountPrice,
    price: product.discountPrice,
    subtotal: product.discountPrice * 2,
    shopId: 'shop-1',
    sellerId: 'seller-1',
    ...(cartLine || {}),
  };
  return Order.create({
    cart: [line],
    user: { _id: 'cust-1', id: 'cust-1', name: 'Cust', email: 'c@t.com' },
    buyerId: 'cust-1',
    sellerId: 'seller-1',
    totalPrice: 200,
    subtotal: 200,
    shippingFee: 0,
    paymentInfo: { type: 'Cash On Delivery', status: 'Pay on delivery' },
    paymentStatus: 'PENDING',
    status: ORDER_STATUSES.PROCESSING,
    sectorId: 'sector-1',
    locationId: 'sector-1',
    ...rest,
  });
}

/**
 * Insert an order carrying a status the model enum now rejects — i.e. a row
 * written before the boot migration rewrote it.
 *
 * The repository queries deliberately stay tolerant of these spellings, so the
 * tolerance still needs testing; but the document can no longer be produced
 * through the model, exactly as it could not in production after the enum was
 * added. Validation is skipped for the same reason, not to work around a bug.
 */
async function seedLegacyOrder(status) {
  const order = await seedOrder();
  await Order.collection.updateOne({ _id: order._id }, { $set: { status } });
  return Order.findById(order._id);
}

// ── normalizeStatus ────────────────────────────────────────────────────
describe('normalizeStatus', () => {
  it('passes canonical values through', () => {
    for (const v of Object.values(ORDER_STATUSES)) {
      assert.strictEqual(normalizeStatus(v), v);
    }
  });

  it('maps legacy uppercase spellings', () => {
    assert.strictEqual(normalizeStatus('PENDING'), ORDER_STATUSES.PROCESSING);
    assert.strictEqual(normalizeStatus('CONFIRMED'), ORDER_STATUSES.CONFIRMED);
    assert.strictEqual(normalizeStatus('CANCELLED'), ORDER_STATUSES.CANCELLED);
    assert.strictEqual(normalizeStatus('DELIVERED'), ORDER_STATUSES.DELIVERED);
    assert.strictEqual(normalizeStatus('SUCCEEDED'), ORDER_STATUSES.DELIVERED);
    assert.strictEqual(normalizeStatus('REFUNDED'), ORDER_STATUSES.REFUND_SUCCESS);
  });

  it('maps title-case refund aliases', () => {
    assert.strictEqual(normalizeStatus('Refund Requested'), ORDER_STATUSES.REFUND_REQUESTED);
    assert.strictEqual(normalizeStatus('refund request'), ORDER_STATUSES.REFUND_REQUESTED);
  });

  it('returns unknown values as-is', () => {
    assert.strictEqual(normalizeStatus('Weird Status'), 'Weird Status');
  });
});

// ── canTransition ──────────────────────────────────────────────────────
describe('canTransition', () => {
  it('allows the happy path Processing → Confirmed → Shipped → In Transit → Delivered', () => {
    assert.ok(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.CONFIRMED));
    assert.ok(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.SHIPPED));
    assert.ok(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.IN_TRANSIT));
    assert.ok(canTransition(ORDER_STATUSES.IN_TRANSIT, ORDER_STATUSES.DELIVERED));
  });

  it('rejects illegal jumps (Processing → Delivered)', () => {
    assert.strictEqual(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.DELIVERED), false);
  });

  it('rejects leaving Cancelled', () => {
    assert.strictEqual(canTransition(ORDER_STATUSES.CANCELLED, ORDER_STATUSES.CONFIRMED), false);
    assert.strictEqual(canTransition(ORDER_STATUSES.CANCELLED, ORDER_STATUSES.DELIVERED), false);
  });

  it('rejects leaving Refund Success', () => {
    assert.strictEqual(canTransition(ORDER_STATUSES.REFUND_SUCCESS, ORDER_STATUSES.DELIVERED), false);
    assert.strictEqual(canTransition(ORDER_STATUSES.REFUND_SUCCESS, ORDER_STATUSES.PROCESSING), false);
  });

  it('allows refund chain only from Delivered', () => {
    assert.ok(canTransition(ORDER_STATUSES.DELIVERED, ORDER_STATUSES.REFUND_REQUESTED));
    assert.strictEqual(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.REFUND_REQUESTED), false);
    assert.strictEqual(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.REFUND_REQUESTED), false);
  });

  it('allows cancel only from Processing/Confirmed (not Shipped/In Transit)', () => {
    assert.ok(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.CANCELLED));
    assert.ok(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.CANCELLED));
    assert.strictEqual(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.CANCELLED), false);
    assert.strictEqual(canTransition(ORDER_STATUSES.IN_TRANSIT, ORDER_STATUSES.CANCELLED), false);
  });

  it('normalizes legacy from-status (PENDING can go to Confirmed)', () => {
    assert.ok(canTransition('PENDING', ORDER_STATUSES.CONFIRMED));
  });
});

// ── refundOrder transition guards ──────────────────────────────────────
describe('refundOrder transition guards', () => {
  it('allows Delivered → Refund Requested', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.DELIVERED });
    const updated = await orderService.refundOrder(order._id, { status: 'Refund Requested' }, { id: 'cust-1', role: 'CUSTOMER' });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_REQUESTED);
  });

  it('rejects refund request from Processing', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING });
    await assert.rejects(
      () => orderService.refundOrder(order._id, { status: 'Refund Requested' }, { id: 'cust-1', role: 'CUSTOMER' }),
      /Cannot transition/
    );
  });

  it('rejects refund request from Cancelled', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.CANCELLED });
    await assert.rejects(
      () => orderService.refundOrder(order._id, { status: 'Refund Requested' }, { id: 'cust-1', role: 'CUSTOMER' }),
      /Cannot transition/
    );
  });

  it('same-status refund is idempotent (no throw)', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.REFUND_REQUESTED });
    const updated = await orderService.refundOrder(order._id, { status: 'Refund Requested' }, { id: 'cust-1', role: 'CUSTOMER' });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_REQUESTED);
  });

  it('forbids refunding another customer\'s order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.DELIVERED });
    await assert.rejects(
      () => orderService.refundOrder(order._id, { status: 'Refund Requested' }, { id: 'other-user', role: 'CUSTOMER' }),
      /Forbidden/
    );
  });

  it('admin may refund any order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.DELIVERED });
    const updated = await orderService.refundOrder(order._id, { status: 'Refund Requested' }, { id: 'admin-1', role: 'ADMIN' });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_REQUESTED);
  });
});

// ── refundSuccess transition + restock ─────────────────────────────────
describe('refundSuccess', () => {
  it('rejects illegal transition (Processing → Refund Success)', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING });
    await assert.rejects(
      () => orderService.refundSuccess(order._id, { status: 'Refund Success' }),
      /Cannot transition/
    );
  });

  it('allows Refund Approved → Refund Success and restocks', async () => {
    const product = await seedProduct({ stock: 8, reserved: 2 });
    const order = await seedOrder({
      status: ORDER_STATUSES.REFUND_APPROVED,
      _product: product,
      cartLine: { quantity: 2, qty: 2 },
    });
    const updated = await orderService.refundSuccess(order._id, { status: 'Refund Success' });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_SUCCESS);
    const reloaded = await Product.findById(product._id);
    // stock was 8; returnStock increments stock by qty (2) → 10
    assert.strictEqual(reloaded.stock, 10);
  });

  it('same-status refundSuccess does NOT double-restock', async () => {
    const product = await seedProduct({ stock: 10, reserved: 0 });
    const order = await seedOrder({
      status: ORDER_STATUSES.REFUND_SUCCESS,
      _product: product,
      cartLine: { quantity: 2, qty: 2 },
    });
    await orderService.refundSuccess(order._id, { status: 'Refund Success' });
    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.stock, 10);
  });
});

// ── updateOrderStatus transition guard ─────────────────────────────────
describe('updateOrderStatus', () => {
  it('accepts legal Processing → Confirmed', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING });
    const updated = await orderService.updateOrderStatus(order._id, { status: 'Confirmed' });
    assert.strictEqual(updated.status, ORDER_STATUSES.CONFIRMED);
    assert.ok(updated.updatedAt instanceof Date);
  });

  it('rejects illegal Processing → Shipped', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING });
    await assert.rejects(
      () => orderService.updateOrderStatus(order._id, { status: 'Shipped' }),
      /Cannot transition/
    );
  });

  it('rejects illegal Cancelled → Confirmed', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.CANCELLED });
    await assert.rejects(
      () => orderService.updateOrderStatus(order._id, { status: 'Confirmed' }),
      /Cannot transition/
    );
  });

  it('stamps deliveredAt on Delivered', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.IN_TRANSIT });
    const updated = await orderService.updateOrderStatus(order._id, { status: 'Delivered' });
    assert.ok(updated.deliveredAt);
  });

  it('stamps updatedAt on status change', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING, updatedAt: new Date('2020-01-01') });
    const updated = await orderService.updateOrderStatus(order._id, { status: 'Confirmed' });
    assert.ok(updated.updatedAt.getTime() > new Date('2020-01-02').getTime());
  });
});

// ── cancelOrder: atomic claim + restock/release ────────────────────────
describe('cancelOrder', () => {
  it('cancels a Processing order and stamps cancelledAt', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING });
    const cancelled = await orderService.cancelOrder(order._id, 'customer requested');
    assert.strictEqual(cancelled.status, ORDER_STATUSES.CANCELLED);
    assert.ok(cancelled.cancelledAt instanceof Date);
    assert.strictEqual(cancelled.paymentStatus, 'PENDING');
  });

  it('cancels a Confirmed order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.CONFIRMED });
    const cancelled = await orderService.cancelOrder(order._id);
    assert.strictEqual(cancelled.status, ORDER_STATUSES.CANCELLED);
  });

  it('rejects cancel from Shipped', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.SHIPPED });
    await assert.rejects(() => orderService.cancelOrder(order._id), /Cannot cancel/);
  });

  it('rejects cancel from Delivered', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.DELIVERED });
    await assert.rejects(() => orderService.cancelOrder(order._id), /Cannot cancel/);
  });

  it('rejects cancel from Refund Requested', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.REFUND_REQUESTED });
    await assert.rejects(() => orderService.cancelOrder(order._id), /Cannot cancel/);
  });

  it('releases reservation when payment still PENDING', async () => {
    const product = await seedProduct({ stock: 10, reserved: 2 });
    const order = await seedOrder({
      status: ORDER_STATUSES.PROCESSING,
      paymentStatus: 'PENDING',
      _product: product,
      cartLine: { quantity: 2, qty: 2 },
    });
    await orderService.cancelOrder(order._id);
    const reloaded = await Product.findById(product._id);
    // releaseReserved decrements reserved, clamped at 0 → 0
    assert.strictEqual(reloaded.reserved, 0);
    assert.strictEqual(reloaded.stock, 10);
  });

  it('rests stock (returnStock) when payment was CONFIRMED', async () => {
    const product = await seedProduct({ stock: 8, reserved: 0 });
    const order = await seedOrder({
      status: ORDER_STATUSES.CONFIRMED,
      paymentStatus: 'CONFIRMED',
      _product: product,
      cartLine: { quantity: 2, qty: 2 },
    });
    const cancelled = await orderService.cancelOrder(order._id);
    assert.strictEqual(cancelled.paymentStatus, 'REFUNDED');
    const reloaded = await Product.findById(product._id);
    // stock was 8 (already deducted at confirm in real flow we simulate by
    // keeping stock at 8 and returning 2 → 10)
    assert.strictEqual(reloaded.stock, 10);
  });

  it('claimCancellation is atomic: second concurrent cancel returns null', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING });
    const first = await orderRepo.claimCancellation(order._id);
    assert.ok(first);
    assert.strictEqual(first.status, ORDER_STATUSES.PROCESSING); // pre-doc
    const second = await orderRepo.claimCancellation(order._id);
    assert.strictEqual(second, null);
    const after = await Order.findById(order._id);
    assert.strictEqual(after.status, ORDER_STATUSES.CANCELLED);
    assert.ok(after.cancelledAt instanceof Date);
  });

  it('claimCancellation rejects a Shipped order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.SHIPPED });
    const claim = await orderRepo.claimCancellation(order._id);
    assert.strictEqual(claim, null);
  });

  it('claimCancellation rejects a legacy CONFIRMED→ later status after claim (payment claim already moved it)', async () => {
    // After payment confirmation the status is Confirmed (cancellable) — but
    // once Shipped, claim must fail.
    const order = await seedOrder({ status: ORDER_STATUSES.SHIPPED });
    assert.strictEqual(await orderRepo.claimCancellation(order._id), null);
  });
});

// ── claimPaymentConfirmation whitelist ─────────────────────────────────
describe('claimPaymentConfirmation', () => {
  it('flips Processing PENDING → Confirmed/CONFIRMED', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING, paymentStatus: 'PENDING' });
    const claimed = await orderRepo.claimPaymentConfirmation(order._id);
    assert.ok(claimed);
    assert.strictEqual(claimed.paymentStatus, 'CONFIRMED');
    assert.strictEqual(claimed.status, ORDER_STATUSES.CONFIRMED);
  });

  it('is idempotent (second claim returns null)', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.PROCESSING, paymentStatus: 'PENDING' });
    await orderRepo.claimPaymentConfirmation(order._id);
    assert.strictEqual(await orderRepo.claimPaymentConfirmation(order._id), null);
  });

  it('refuses to claim a Cancelled order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.CANCELLED, paymentStatus: 'PENDING' });
    assert.strictEqual(await orderRepo.claimPaymentConfirmation(order._id), null);
  });

  it('refuses to claim a Refund Requested order (no backwards jump)', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.REFUND_REQUESTED, paymentStatus: 'CONFIRMED' });
    assert.strictEqual(await orderRepo.claimPaymentConfirmation(order._id), null);
  });

  it('refuses to claim a Delivered order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.DELIVERED, paymentStatus: 'CONFIRMED' });
    assert.strictEqual(await orderRepo.claimPaymentConfirmation(order._id), null);
  });

  it('refuses to claim a Shipped order', async () => {
    const order = await seedOrder({ status: ORDER_STATUSES.SHIPPED, paymentStatus: 'PENDING' });
    assert.strictEqual(await orderRepo.claimPaymentConfirmation(order._id), null);
  });

  it('accepts a legacy PENDING status document', async () => {
    const order = await seedLegacyOrder('PENDING');
    const claimed = await orderRepo.claimPaymentConfirmation(order._id);
    assert.ok(claimed);
    assert.strictEqual(claimed.status, ORDER_STATUSES.CONFIRMED);
  });
});

// ── existsOwnedOrder cancellation exclusion ────────────────────────────
describe('existsOwnedOrder', () => {
  it('returns truthy for a Processing order containing the product', async () => {
    const product = await seedProduct();
    await seedOrder({ status: ORDER_STATUSES.PROCESSING, _product: product });
    // Mongoose Model.exists() returns { _id } | null — coerce to boolean.
    assert.strictEqual(!!(await orderRepo.existsOwnedOrder('cust-1', product._id)), true);
  });

  it('returns falsy for a canonical Cancelled order', async () => {
    const product = await seedProduct();
    await seedOrder({ status: ORDER_STATUSES.CANCELLED, _product: product });
    assert.strictEqual(!!(await orderRepo.existsOwnedOrder('cust-1', product._id)), false);
  });

  it('returns falsy for a legacy CANCELLED order', async () => {
    const product = await seedProduct();
    const order = await seedOrder({ _product: product });
    await Order.collection.updateOne({ _id: order._id }, { $set: { status: 'CANCELLED' } });
    assert.strictEqual(!!(await orderRepo.existsOwnedOrder('cust-1', product._id)), false);
  });

  it('returns falsy for a different customer', async () => {
    const product = await seedProduct();
    await seedOrder({ status: ORDER_STATUSES.DELIVERED, _product: product });
    assert.strictEqual(!!(await orderRepo.existsOwnedOrder('someone-else', product._id)), false);
  });
});

// ── payments.service: field mapping + order sync ──────────────────────
describe('payments.service ↔ order consistency', () => {
  it('createPayment reads buyerId and totalPrice from the order', async () => {
    const order = await seedOrder({ buyerId: 'cust-1', totalPrice: 250, sellerId: 'seller-1' });
    const payment = await paymentService.createPayment({ orderId: String(order._id), paymentMethod: 'COD' });
    assert.strictEqual(payment.userId, 'cust-1');
    assert.strictEqual(payment.sellerId, 'seller-1');
    assert.strictEqual(payment.amount, 250);
    assert.strictEqual(payment.status, 'PENDING');
  });

  it('createPayment does not create a duplicate for the same order', async () => {
    const order = await seedOrder();
    await paymentService.createPayment({ orderId: String(order._id) });
    await assert.rejects(
      () => paymentService.createPayment({ orderId: String(order._id) }),
      /already exists/
    );
  });

  it('createPayment rejects a missing order', async () => {
    await assert.rejects(
      () => paymentService.createPayment({ orderId: oid() }),
      /Order not found/
    );
  });

  it('updatePaymentStatus COMPLETED syncs Order.paymentStatus → CONFIRMED', async () => {
    const order = await seedOrder({ paymentStatus: 'PENDING' });
    const payment = await paymentService.createPayment({ orderId: String(order._id) });
    await paymentService.updatePaymentStatus(payment._id, 'COMPLETED');
    const reloaded = await Order.findById(order._id);
    assert.strictEqual(reloaded.paymentStatus, 'CONFIRMED');
  });

  it('updatePaymentStatus FAILED syncs Order.paymentStatus → FAILED', async () => {
    const order = await seedOrder({ paymentStatus: 'PENDING' });
    const payment = await paymentService.createPayment({ orderId: String(order._id) });
    await paymentService.updatePaymentStatus(payment._id, 'FAILED');
    const reloaded = await Order.findById(order._id);
    assert.strictEqual(reloaded.paymentStatus, 'FAILED');
  });

  it('updatePaymentStatus rejects an invalid vocabulary value', async () => {
    const order = await seedOrder();
    const payment = await paymentService.createPayment({ orderId: String(order._id) });
    await assert.rejects(
      () => paymentService.updatePaymentStatus(payment._id, 'PAID'),
      /Invalid payment status/
    );
  });

  it('processRefund syncs Order.paymentStatus → REFUNDED', async () => {
    const order = await seedOrder({ paymentStatus: 'CONFIRMED' });
    const payment = await paymentService.createPayment({
      orderId: String(order._id),
      status: 'COMPLETED',
    });
    await paymentService.processRefund(payment._id);
    const reloadedPay = await paymentRepo.findById(payment._id);
    assert.strictEqual(reloadedPay.status, 'REFUNDED');
    const reloadedOrder = await Order.findById(order._id);
    assert.strictEqual(reloadedOrder.paymentStatus, 'REFUNDED');
  });

  // ── sold_out maintenance ───────────────────────────────────────────
  it('incrementSoldOut increments sold_out on payment confirmation', async () => {
    const product = await seedProduct({ sold_out: 0 });
    const order = await seedOrder({
      _product: product,
      paymentStatus: 'PENDING',
      cartLine: { quantity: 3 },
    });

    // Confirm payment → triggers deductInventoryOnPayment → incrementSoldOut
    const claimed = await orderRepo.claimPaymentConfirmation(order._id);
    assert.ok(claimed);
    await orderService.deductInventoryOnPayment(order.cart, order._id);

    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.sold_out, 3);
  });

  it('sold_out is NOT incremented for unpaid orders', async () => {
    const product = await seedProduct({ sold_out: 0 });
    await seedOrder({
      _product: product,
      quantity: 5,
      paymentStatus: 'PENDING',
    });

    const productAfter = await Product.findById(product._id);
    assert.strictEqual(productAfter.sold_out, 0);
  });

  it('sold_out is NOT incremented for cancelled orders', async () => {
    const product = await seedProduct({ sold_out: 0 });
    await seedOrder({
      _product: product,
      quantity: 5,
      status: ORDER_STATUSES.CANCELLED,
      paymentStatus: 'CONFIRMED',
    });

    const productAfter = await Product.findById(product._id);
    assert.strictEqual(productAfter.sold_out, 0);
  });

  it('returnStock decrements sold_out on refund (clamped at 0)', async () => {
    const product = await seedProduct({ sold_out: 5 });
    await productRepository.returnStock(product._id, 3);

    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.sold_out, 2);
  });

  it('returnStock clamps sold_out at 0', async () => {
    const product = await seedProduct({ sold_out: 1 });
    await productRepository.returnStock(product._id, 5);

    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.sold_out, 0);
  });

  it('ignores a client-supplied payment status on create (server owns it)', async () => {
    // `status` is deliberately NOT read from the payload — a caller must not be
    // able to manufacture a paid payment. The bogus value is dropped rather
    // than persisted, so the model enum never sees it.
    const order = await seedOrder();
    const payment = await paymentService.createPayment({
      orderId: String(order._id),
      status: 'NOT_A_STATUS',
    });
    assert.strictEqual(payment.status, 'PENDING');
    const stored = await paymentRepo.findById(payment._id);
    assert.strictEqual(stored.status, 'PENDING');
  });
});

// ── model hooks ────────────────────────────────────────────────────────
describe('Order model', () => {
  it('has updatedAt default and refreshes on save', async () => {
    const order = await seedOrder({ updatedAt: new Date('2020-01-01') });
    // create() bypasses pre-save for defaults sometimes; force a save
    order.status = ORDER_STATUSES.CONFIRMED;
    await order.save();
    assert.ok(order.updatedAt.getTime() > new Date('2020-01-02').getTime());
  });

  it('has cancelledAt field', async () => {
    const order = await seedOrder();
    order.cancelledAt = new Date();
    await order.save();
    const reloaded = await Order.findById(order._id);
    assert.ok(reloaded.cancelledAt instanceof Date);
  });
});
