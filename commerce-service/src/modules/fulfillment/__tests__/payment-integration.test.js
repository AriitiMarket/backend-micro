/**
 * PAYMENT & TRANSACTION INTEGRATION TESTS
 *
 * Exercises the REAL Express routers (payments.routes, wallets.routes,
 * paymentWebhook.routes, allocation.routes) over real HTTP against a real
 * MongoDB test database. Nothing is mocked: the routes, the middleware
 * (authenticate / authorize / verifyWebhookSignature), the controllers, the
 * services and the repositories all run for real.
 *
 * The only substitution is the cluster boundary: `gatewayOnly` is replaced by
 * a test shim that sets `req.fromGateway = true` and lifts the gateway's
 * identity headers into `req.user`, exactly as the API Gateway does. The
 * webhook route is mounted in isolation so its HMAC signature middleware still
 * runs for real.
 *
 * Sandbox note: the platform has exactly one settlement rail configured
 * (Cash on Delivery, type OFFLINE). BANK_TRANSFER / TELEBIRR / CBE_BIRR are
 * INACTIVE and unconfigured, so there is no third-party provider sandbox to
 * call. The provider callback is therefore exercised through the platform's
 * own signed provider-callback endpoint, which is the trusted confirmation
 * mechanism the code actually implements.
 *
 * Run with: node --test src/modules/fulfillment/__tests__/payment-integration.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const mongoose = require('mongoose');
const { describe, it, before, after, beforeEach } = require('node:test');

const DB_URL = 'mongodb://localhost:27017/ariti_commerce_test_payment_integration';
const WEBHOOK_SECRET = 'test-webhook-secret-not-a-real-credential';

process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;

const express = require('express');
const bodyParser = require('body-parser');

const paymentsRoutes = require('../routes/payments.routes');
const walletsRoutes = require('../routes/wallets.routes');
const allocationRoutes = require('../routes/allocation.routes');
const paymentWebhookRoutes = require('../routes/paymentWebhook.routes');

const Order = require('../models/Orders');
const Payment = require('../models/Payments');
const SellerAllocation = require('../models/SellerAllocation');
const SellerWallet = require('../models/SellerWallet');
const WalletTransaction = require('../models/WalletTransaction');
const PaymentMethod = require('../models/PaymentMethods');

const { ORDER_STATUSES } = require('../constants/orderStatuses');

const BUYER = 'buyer-1';
const OTHER_BUYER = 'buyer-2';
const SELLER_A = 'seller-a';
const SELLER_B = 'seller-b';
const ADMIN = 'admin-1';

/**
 * Test harness app. The cluster boundary is stubbed (see file header); every
 * other layer of the stack is the production one.
 */
function buildApp() {
  const app = express();
  app.use(bodyParser.json());

  // Stands in for the API Gateway: it is the only component allowed to assert
  // an identity, and it does so via signed headers.
  app.use((req, res, next) => {
    req.fromGateway = true;
    const id = req.headers['x-user-id'];
    if (id) {
      req.user = {
        id: String(id),
        sub: String(id),
        email: req.headers['x-user-email'] || null,
        role: req.headers['x-user-role'] || 'BUYER',
      };
    }
    next();
  });

  app.use('/payment', paymentsRoutes);
  app.use('/payment', allocationRoutes);
  app.use('/wallet', walletsRoutes);
  app.use('/internal/commerce/payment-webhook', paymentWebhookRoutes);

  // Same terminal handlers the real app installs (see src/app/app.js).
  const { notFound } = require('../../../app/middleware/errorHandler');
  const { standardErrorHandler } = require('../../../shared/middleware/standardErrorHandler');
  app.use(notFound);
  app.use(standardErrorHandler);
  return app;
}

let server;
let baseUrl;

async function request(method, path, { body, user, role, headers = {} } = {}) {
  const requestHeaders = { 'Content-Type': 'application/json', ...headers };
  if (user) {
    requestHeaders['x-user-id'] = user;
    requestHeaders['x-user-role'] = role || 'BUYER';
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (_e) { payload = text; }
  }
  return { status: response.status, body: payload };
}

/** Build a correctly signed provider callback, exactly as a provider would. */
function signWebhook(payload) {
  const timestamp = String(Date.now());
  const serialized = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${serialized}`)
    .digest('hex');
  return {
    'x-payment-signature': signature,
    'x-payment-timestamp': timestamp,
  };
}

async function postWebhook(payload, { headers } = {}) {
  return request('POST', '/internal/commerce/payment-webhook', {
    body: payload,
    headers: headers || signWebhook(payload),
  });
}

/** A single-seller order with known money values. */
async function seedOrder(overrides = {}) {
  return Order.create({
    cart: [{ _id: 'p-1', productId: 'p-1', name: 'Widget', quantity: 1, qty: 1, discountPrice: 600, price: 600, subtotal: 600 }],
    user: { id: BUYER, name: 'Buyer', email: 'b@example.com' },
    buyerId: BUYER,
    subtotal: 600,
    shippingFee: 0,
    currency: 'ETB',
    totalPrice: 600,
    paymentStatus: 'PENDING',
    status: ORDER_STATUSES.PROCESSING,
    sellerId: SELLER_A,
    shopId: 'shop-a',
    sellerShipments: [{
      sellerId: SELLER_A,
      shopId: 'shop-a',
      items: [{ name: 'Widget', quantity: 1, subtotal: 600 }],
      subtotal: 600,
    }],
    ...overrides,
  });
}

/** A two-seller order: seller A 600 ETB, seller B 400 ETB (1,000 ETB total). */
async function seedTwoSellerOrder(overrides = {}) {
  return Order.create({
    cart: [
      { _id: 'p-1', productId: 'p-1', name: 'Widget A', quantity: 1, qty: 1, discountPrice: 600, price: 600, subtotal: 600 },
      { _id: 'p-2', productId: 'p-2', name: 'Widget B', quantity: 1, qty: 1, discountPrice: 400, price: 400, subtotal: 400 },
    ],
    user: { id: BUYER, name: 'Buyer', email: 'b@example.com' },
    buyerId: BUYER,
    subtotal: 1000,
    shippingFee: 0,
    currency: 'ETB',
    totalPrice: 1000,
    paymentStatus: 'PENDING',
    status: ORDER_STATUSES.PROCESSING,
    sellerId: SELLER_A,
    shopId: 'shop-a',
    orderGroupId: 'group-two-seller',
    sellerShipments: [
      { sellerId: SELLER_A, shopId: 'shop-a', items: [{ name: 'Widget A', quantity: 1, subtotal: 600 }], subtotal: 600 },
      { sellerId: SELLER_B, shopId: 'shop-b', items: [{ name: 'Widget B', quantity: 1, subtotal: 400 }], subtotal: 400 },
    ],
    ...overrides,
  });
}

before(async () => {
  await mongoose.connect(DB_URL);
  await Promise.all([
    Order.deleteMany({}),
    Payment.deleteMany({}),
    SellerAllocation.deleteMany({}),
    SellerWallet.deleteMany({}),
    WalletTransaction.deleteMany({}),
    PaymentMethod.deleteMany({}),
  ]);
  await Promise.all([Order.init(), Payment.init(), SellerAllocation.init(), SellerWallet.init(), WalletTransaction.init()]);

  // Commission comes from platform settings; pin it so the expected numbers in
  // these tests are deterministic. The rate itself is existing platform policy
  // (default 10% of the seller's gross subtotal) — nothing here changes it.
  const settingsService = require('../../platform/services/settings.service');
  await settingsService.updatePlatformSettings({ commissionRate: 10, taxRate: 0 });

  server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.close();
});

beforeEach(async () => {
  await Promise.all([
    Payment.deleteMany({}),
    SellerAllocation.deleteMany({}),
    SellerWallet.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. PAYMENT INITIATION — POST /payment/create-payment
// ─────────────────────────────────────────────────────────────────────────────
describe('1. Payment initiation', () => {
  it('creates a PENDING payment for an eligible order with a server-derived amount', async () => {
    const order = await seedOrder();
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: BUYER,
      role: 'BUYER',
    });

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    const payment = res.body.payment;
    assert.strictEqual(payment.status, 'PENDING');
    assert.strictEqual(payment.amount, 600, 'amount must come from the order, not the client');
    assert.strictEqual(payment.currency, 'ETB');
    assert.strictEqual(payment.orderId, String(order._id));
    assert.strictEqual(payment.userId, BUYER);
    assert.strictEqual(payment.sellerId, SELLER_A);
    assert.ok(payment._id, 'a transaction reference must be returned');
  });

  it('ignores a client-supplied amount and status and uses the trusted order total', async () => {
    const order = await seedOrder({ totalPrice: 600 });
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD', amount: 1, status: 'COMPLETED' },
      user: BUYER,
      role: 'BUYER',
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.payment.amount, 600, 'client amount must be ignored');
    assert.strictEqual(res.body.payment.status, 'PENDING', 'client status must be ignored');
  });

  it('rejects payment for a nonexistent order (404)', async () => {
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: '64b7f9c2e4b0a1d2c3e4f5a6', paymentMethod: 'COD' },
      user: BUYER,
      role: 'BUYER',
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(await Payment.countDocuments({}), 0);
  });

  it("rejects payment for another buyer's order (403)", async () => {
    const order = await seedOrder();
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: OTHER_BUYER,
      role: 'BUYER',
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(await Payment.countDocuments({}), 0, 'no payment row may be written');
  });

  it('rejects an unsupported (non-COD) payment method (400)', async () => {
    const order = await seedOrder();
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'TELEBIRR' },
      user: BUYER,
      role: 'BUYER',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(await Payment.countDocuments({}), 0);
  });

  it('rejects a request with no orderId', async () => {
    const res = await request('POST', '/payment/create-payment', {
      body: { paymentMethod: 'COD' },
      user: BUYER,
      role: 'BUYER',
    });
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    assert.strictEqual(await Payment.countDocuments({}), 0);
  });

  it('rejects a duplicate payment for the same order (409) and keeps the first row', async () => {
    const order = await seedOrder();
    const first = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(first.status, 201);

    const second = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(second.status, 409, 'a retry must not create a second payment');
    assert.strictEqual(await Payment.countDocuments({ orderId: String(order._id) }), 1);
  });

  it("rejects a seller creating a payment for another seller's order (403)", async () => {
    const order = await seedOrder();
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: 'seller-zzz', role: 'SELLER',
    });
    assert.strictEqual(res.status, 403);
  });

  it('requires authentication (401 without identity)', async () => {
    const order = await seedOrder();
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
    });
    assert.strictEqual(res.status, 401);
  });

  it('lists only the ACTIVE payment methods', async () => {
    const res = await request('GET', '/payment/get-active-methods', { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 200);
    const methods = res.body.methods;
    assert.ok(methods.length >= 1);
    assert.ok(methods.every((m) => m.status === 'ACTIVE'));
    assert.ok(methods.some((m) => m.key === 'COD'), 'COD must be offered');
    assert.ok(!methods.some((m) => m.key === 'TELEBIRR'), 'unconfigured rails must not be offered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PAYMENT RETRIEVAL & ACCESS CONTROL
// ─────────────────────────────────────────────────────────────────────────────
describe('2. Payment retrieval and access control', () => {
  async function createPaymentFor(order) {
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.payment;
  }

  it('the owning buyer can read their payment', async () => {
    const order = await seedOrder();
    const payment = await createPaymentFor(order);
    const res = await request('GET', `/payment/get-payment/${payment._id}`, { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.payment._id, payment._id);
  });

  it("another buyer cannot read someone else's payment (403)", async () => {
    const order = await seedOrder();
    const payment = await createPaymentFor(order);
    const res = await request('GET', `/payment/get-payment/${payment._id}`, { user: OTHER_BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it('a seller cannot read a payment for another seller (403)', async () => {
    const order = await seedOrder();
    const payment = await createPaymentFor(order);
    const res = await request('GET', `/payment/get-payment/${payment._id}`, { user: 'seller-zzz', role: 'SELLER' });
    assert.strictEqual(res.status, 403);
  });

  it('the owning seller can read the payment for their sale', async () => {
    const order = await seedOrder();
    const payment = await createPaymentFor(order);
    const res = await request('GET', `/payment/get-payment/${payment._id}`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 200);
  });

  it("a buyer cannot list another buyer's payments (403)", async () => {
    const res = await request('GET', `/payment/get-user-payments/${OTHER_BUYER}`, { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it("a seller cannot list another seller's payments (403)", async () => {
    const res = await request('GET', `/payment/get-seller-payments/${SELLER_B}`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 403);
  });

  it('only an admin may list all payments (403 for a buyer)', async () => {
    const res = await request('GET', '/payment/get-all-payments', { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it('an admin may list all payments', async () => {
    const order = await seedOrder();
    await createPaymentFor(order);
    const res = await request('GET', '/payment/get-all-payments', { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.payments));
    assert.strictEqual(res.body.payments.length, 1);
  });

  it('the buyer can read their own transaction history', async () => {
    const order = await seedOrder();
    await createPaymentFor(order);
    const res = await request('GET', `/payment/get-user-payments/${BUYER}`, { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.payments.length, 1);
    assert.strictEqual(res.body.payments[0].orderId, String(order._id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PAYMENT CONFIRMATION — the signed provider callback
//    POST /internal/commerce/payment-webhook
// ─────────────────────────────────────────────────────────────────────────────
describe('3. Payment confirmation (signed provider callback)', () => {
  it('confirms a pending payment, flips the order to CONFIRMED and records the provider reference', async () => {
    const order = await seedOrder();
    await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: BUYER, role: 'BUYER',
    });

    const res = await postWebhook({
      idempotencyKey: 'idem-confirm-1',
      orderId: String(order._id),
      transactionId: 'provider-txn-001',
      paymentMethod: 'COD',
      status: 'COMPLETED',
      amount: 600,
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);

    const payment = await Payment.findOne({ orderId: String(order._id) });
    assert.strictEqual(payment.status, 'COMPLETED');
    assert.strictEqual(payment.transactionId, 'provider-txn-001');
    assert.strictEqual(payment.amount, 600);
    assert.strictEqual(payment.currency, 'ETB');
    assert.ok(payment.updatedAt instanceof Date);

    const updatedOrder = await Order.findById(order._id);
    assert.strictEqual(updatedOrder.paymentStatus, 'CONFIRMED');
    assert.ok(updatedOrder.paidAt, 'a confirmed payment must stamp paidAt');
  });

  it('records a FAILED payment and marks the order FAILED', async () => {
    const order = await seedOrder();
    const res = await postWebhook({
      idempotencyKey: 'idem-fail-1',
      orderId: String(order._id),
      transactionId: 'provider-txn-fail',
      paymentMethod: 'COD',
      status: 'FAILED',
    });
    assert.strictEqual(res.status, 200);

    const payment = await Payment.findOne({ orderId: String(order._id) });
    assert.strictEqual(payment.status, 'FAILED');
    const updatedOrder = await Order.findById(order._id);
    assert.strictEqual(updatedOrder.paymentStatus, 'FAILED');
  });

  it('records a PENDING payment without changing the order', async () => {
    const order = await seedOrder();
    const res = await postWebhook({
      idempotencyKey: 'idem-pending-1',
      orderId: String(order._id),
      transactionId: 'provider-txn-pending',
      paymentMethod: 'COD',
      status: 'PENDING',
    });
    assert.strictEqual(res.status, 200);

    const payment = await Payment.findOne({ orderId: String(order._id) });
    assert.strictEqual(payment.status, 'PENDING');
    const updatedOrder = await Order.findById(order._id);
    assert.strictEqual(updatedOrder.paymentStatus, 'PENDING');
  });

  it('rejects a callback with no idempotencyKey (400)', async () => {
    const order = await seedOrder();
    const res = await postWebhook({ orderId: String(order._id), status: 'COMPLETED' });
    assert.strictEqual(res.status, 400);
  });

  it('rejects a callback for an unknown order (404)', async () => {
    const res = await postWebhook({
      idempotencyKey: 'idem-unknown-order',
      orderId: '64b7f9c2e4b0a1d2c3e4f5a6',
      status: 'COMPLETED',
    });
    assert.strictEqual(res.status, 404);
  });

  it('rejects an unknown payment status (400)', async () => {
    const order = await seedOrder();
    const res = await postWebhook({
      idempotencyKey: 'idem-bad-status',
      orderId: String(order._id),
      status: 'TOTALLY_MADE_UP',
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects a callback with an invalid signature (401)', async () => {
    const order = await seedOrder();
    const res = await postWebhook(
      { idempotencyKey: 'idem-bad-sig', orderId: String(order._id), status: 'COMPLETED' },
      { headers: { 'x-payment-signature': 'deadbeef'.repeat(8), 'x-payment-timestamp': String(Date.now()) } },
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(await Payment.countDocuments({}), 0, 'no payment may be written for a forged callback');
  });

  it('rejects a callback with a stale timestamp (401 replay guard)', async () => {
    const order = await seedOrder();
    const payload = { idempotencyKey: 'idem-stale', orderId: String(order._id), status: 'COMPLETED' };
    const oldTimestamp = String(Date.now() - 10 * 60 * 1000);
    const signature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(`${oldTimestamp}.${JSON.stringify(payload)}`)
      .digest('hex');
    const res = await postWebhook(payload, {
      headers: { 'x-payment-signature': signature, 'x-payment-timestamp': oldTimestamp },
    });
    assert.strictEqual(res.status, 401);
  });

  it('rejects a callback with no signature headers at all (401)', async () => {
    const order = await seedOrder();
    const res = await postWebhook(
      { idempotencyKey: 'idem-nosig', orderId: String(order._id), status: 'COMPLETED' },
      { headers: {} },
    );
    assert.strictEqual(res.status, 401);
  });

  it('rejects a callback whose amount disagrees with the order total (409)', async () => {
    const order = await seedOrder({ totalPrice: 600 });
    const res = await postWebhook({
      idempotencyKey: 'idem-amount-1', orderId: String(order._id),
      status: 'COMPLETED', amount: 1,
    });
    assert.strictEqual(res.status, 409, 'a mismatched provider amount must not settle the payment');
    assert.strictEqual(await Payment.countDocuments({}), 0, 'no payment row may be written for a mismatched amount');
  });

  it('rejects a callback whose currency disagrees with the order currency (409)', async () => {
    const order = await seedOrder({ totalPrice: 600, currency: 'ETB' });
    const res = await postWebhook({
      idempotencyKey: 'idem-currency-1', orderId: String(order._id),
      status: 'COMPLETED', amount: 600, currency: 'USD',
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await Payment.countDocuments({}), 0);
  });

  it('accepts a callback whose amount matches the order total', async () => {
    const order = await seedOrder({ totalPrice: 600 });
    const res = await postWebhook({
      idempotencyKey: 'idem-amount-ok', orderId: String(order._id),
      status: 'COMPLETED', amount: 600,
    });
    assert.strictEqual(res.status, 200);
    const payment = await Payment.findOne({ orderId: String(order._id) });
    assert.strictEqual(payment.amount, 600);
  });

  it('is idempotent: a duplicate callback does not create a second transaction', async () => {
    const order = await seedOrder();
    const payload = {
      idempotencyKey: 'idem-dupe-1',
      orderId: String(order._id),
      transactionId: 'provider-txn-dupe',
      paymentMethod: 'COD',
      status: 'COMPLETED',
    };
    const first = await postWebhook(payload);
    const second = await postWebhook(payload);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(await Payment.countDocuments({ orderId: String(order._id) }), 1);
  });

  it('a second callback with a DIFFERENT idempotency key for an already-completed order is a no-op', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-key-a', orderId: String(order._id),
      transactionId: 'txn-a', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const before = await SellerWallet.findOne({ sellerId: SELLER_A });
    const beforePending = before ? before.pendingBalance : 0;

    const second = await postWebhook({
      idempotencyKey: 'idem-key-b', orderId: String(order._id),
      transactionId: 'txn-b', paymentMethod: 'COD', status: 'COMPLETED',
    });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.idempotent, true, 'a repeat settlement must be reported as idempotent');

    const after = await SellerWallet.findOne({ sellerId: SELLER_A });
    assert.strictEqual(after ? after.pendingBalance : 0, beforePending, 'a repeat settlement must not credit the wallet twice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SELLER ALLOCATION & PLATFORM COMMISSION
// ─────────────────────────────────────────────────────────────────────────────
describe('4. Seller allocation and platform commission', () => {
  it('allocates the two-seller order with the configured 10% commission', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-alloc-1', orderId: String(order._id),
      transactionId: 'txn-alloc', paymentMethod: 'COD', status: 'COMPLETED',
    });

    const allocations = await SellerAllocation.find({ orderId: String(order._id) }).sort({ sellerId: 1 });
    assert.strictEqual(allocations.length, 2, 'one allocation row per seller');

    const a = allocations.find((r) => r.sellerId === SELLER_A);
    const b = allocations.find((r) => r.sellerId === SELLER_B);

    // Seller A: 600 gross, 10% commission = 60, net = 540
    assert.strictEqual(a.grossSubtotal, 600);
    assert.strictEqual(a.commissionRate, 10);
    assert.strictEqual(a.platformCommission, 60);
    assert.strictEqual(a.netPayable, 540);

    // Seller B: 400 gross, 10% commission = 40, net = 360
    assert.strictEqual(b.grossSubtotal, 400);
    assert.strictEqual(b.platformCommission, 40);
    assert.strictEqual(b.netPayable, 360);

    // Reconciliation: net payable + commission == the merchandise value
    const totalCommission = a.platformCommission + b.platformCommission;
    const totalNet = a.netPayable + b.netPayable;
    assert.strictEqual(totalCommission, 100);
    assert.strictEqual(totalNet + totalCommission, 1000, 'allocations must reconcile to the order value');
  });

  it('is idempotent: re-allocating the same order does not duplicate rows or money', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-alloc-2', orderId: String(order._id),
      transactionId: 'txn-alloc-2', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const first = await SellerAllocation.find({ orderId: String(order._id) }).lean();
    assert.strictEqual(first.length, 2);

    // Re-run allocation (what a repeated delivery/provider event would do).
    const allocationService = require('../services/allocation.service');
    await allocationService.allocateOrder(await Order.findById(order._id), null);

    const second = await SellerAllocation.find({ orderId: String(order._id) }).lean();
    assert.strictEqual(second.length, 2, 'a repeat allocation must not add rows');
    const before = first.reduce((s, r) => s + r.netPayable, 0);
    const after = second.reduce((s, r) => s + r.netPayable, 0);
    assert.strictEqual(after, before, 'a repeat allocation must not change the money');
  });

  it('refuses to allocate an order whose payment is not confirmed (409)', async () => {
    const order = await seedOrder();
    const res = await request('POST', `/payment/allocate/${order._id}`, { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 409);
  });

  it('a seller may read only their own allocation rows', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-alloc-3', orderId: String(order._id),
      transactionId: 'txn-alloc-3', paymentMethod: 'COD', status: 'COMPLETED',
    });

    const own = await request('GET', `/payment/seller-allocations/${SELLER_A}`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(own.status, 200);
    assert.ok(own.body.allocations.every((r) => r.sellerId === SELLER_A));

    const other = await request('GET', `/payment/seller-allocations/${SELLER_B}`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(other.status, 403, 'a seller must not read another seller\'s financial rows');
  });

  it('an admin may read the platform-wide allocation ledger', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-alloc-4', orderId: String(order._id),
      transactionId: 'txn-alloc-4', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const res = await request('GET', '/payment/admin/allocations', { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.allocations.length, 2);
  });

  it('a buyer may not read the admin allocation ledger (403)', async () => {
    const res = await request('GET', '/payment/admin/allocations', { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it('an admin refund against an allocation reverses commission pro-rata', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-refund-alloc', orderId: String(order._id),
      transactionId: 'txn-refund-alloc', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const allocation = await SellerAllocation.findOne({ orderId: String(order._id), sellerId: SELLER_A });

    const res = await request('POST', `/payment/admin/allocations/${allocation._id}/refund`, {
      body: { amount: 100, reason: 'test refund' },
      user: ADMIN, role: 'ADMIN',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const updated = await SellerAllocation.findById(allocation._id);
    assert.strictEqual(updated.refundAmount, 100);
    assert.strictEqual(updated.platformCommission, 50, '10% of the refunded 100 is reversed: 60 - 10');
    // netPayable = grossSubtotal 600 - commission 50 - refund 100 = 450
    assert.strictEqual(updated.netPayable, 450);
  });

  it('an admin refund may not exceed the seller net payable (400)', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-refund-over', orderId: String(order._id),
      transactionId: 'txn-refund-over', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const allocation = await SellerAllocation.findOne({ orderId: String(order._id), sellerId: SELLER_A });

    const res = await request('POST', `/payment/admin/allocations/${allocation._id}/refund`, {
      body: { amount: 5000, reason: 'too much' },
      user: ADMIN, role: 'ADMIN',
    });
    assert.strictEqual(res.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SELLER WALLET
// ─────────────────────────────────────────────────────────────────────────────
describe('5. Seller wallet', () => {
  it('a confirmed payment credits the seller wallet as PENDING (held) balance', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-1', orderId: String(order._id),
      transactionId: 'txn-wallet-1', paymentMethod: 'COD', status: 'COMPLETED',
    });

    const wallet = await SellerWallet.findOne({ sellerId: SELLER_A });
    assert.ok(wallet, 'a confirmed payment must create/credit the seller wallet');
    assert.strictEqual(wallet.pendingBalance, 540, 'net payable (600 - 60 commission) is held as pending');
    assert.strictEqual(wallet.availableBalance, 0, 'held funds must not be spendable yet');
    assert.strictEqual(wallet.totalEarned, 600);
    assert.strictEqual(wallet.totalCommissionDeducted, 60);
  });

  it('writes an auditable ledger entry for the credit', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-2', orderId: String(order._id),
      transactionId: 'txn-wallet-2', paymentMethod: 'COD', status: 'COMPLETED',
    });

    const entries = await WalletTransaction.find({ sellerId: SELLER_A });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].transactionType, 'ORDER_ALLOCATION');
    assert.strictEqual(entries[0].amount, 540);
    assert.strictEqual(entries[0].direction, 'CREDIT');
    assert.strictEqual(entries[0].orderId, String(order._id));
    assert.strictEqual(entries[0].currency, 'ETB');
  });

  it('a FAILED payment creates no seller earnings', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-fail', orderId: String(order._id),
      transactionId: 'txn-wallet-fail', paymentMethod: 'COD', status: 'FAILED',
    });

    const wallet = await SellerWallet.findOne({ sellerId: SELLER_A });
    assert.ok(!wallet || wallet.pendingBalance === 0, 'a failed payment must not create spendable earnings');
    assert.strictEqual(await WalletTransaction.countDocuments({ sellerId: SELLER_A }), 0);
  });

  it('a PENDING payment creates no seller earnings', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-pending', orderId: String(order._id),
      transactionId: 'txn-wallet-pending', paymentMethod: 'COD', status: 'PENDING',
    });
    const wallet = await SellerWallet.findOne({ sellerId: SELLER_A });
    assert.ok(!wallet || wallet.pendingBalance === 0, 'a pending payment must not create spendable earnings');
    assert.strictEqual(await WalletTransaction.countDocuments({ sellerId: SELLER_A }), 0);
  });

  it('a seller may read their own wallet', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-3', orderId: String(order._id),
      transactionId: 'txn-wallet-3', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const res = await request('GET', `/wallet/${SELLER_A}`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.sellerId, SELLER_A);
    assert.strictEqual(res.body.data.pendingBalance, 540);
    assert.strictEqual(res.body.data.availableBalance, 0);
  });

  it('a seller may not read another seller\'s wallet (403)', async () => {
    const res = await request('GET', `/wallet/${SELLER_B}`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 403);
  });

  it('a buyer may not read any wallet (403)', async () => {
    const res = await request('GET', `/wallet/${SELLER_A}`, { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it('a seller may read their own wallet transaction history', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-4', orderId: String(order._id),
      transactionId: 'txn-wallet-4', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const res = await request('GET', `/wallet/${SELLER_A}/transactions`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 200);
    const rows = res.body.data;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, 'ORDER_ALLOCATION');
    assert.strictEqual(rows[0].amount, 540);
    assert.strictEqual(rows[0].direction, 'CREDIT');
    assert.strictEqual(rows[0].relatedOrderId, String(order._id));
  });

  it('a seller may not read another seller\'s wallet ledger (403)', async () => {
    const res = await request('GET', `/wallet/${SELLER_B}/transactions`, { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 403);
  });

  it('the wallet balance reconciles with its ledger entries', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-wallet-5', orderId: String(order._id),
      transactionId: 'txn-wallet-5', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const wallet = await SellerWallet.findOne({ sellerId: SELLER_A });
    const entries = await WalletTransaction.find({ sellerId: SELLER_A });
    const credited = entries
      .filter((e) => e.direction === 'CREDIT' && e.transactionType === 'ORDER_ALLOCATION')
      .reduce((sum, e) => sum + e.amount, 0);
    assert.strictEqual(credited, wallet.pendingBalance + wallet.availableBalance);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ADMIN CONTROLS & AUDITABILITY
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Administrative controls', () => {
  it('an admin may list every wallet', async () => {
    const res = await request('GET', '/wallet/admin/wallets', { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });

  it('a seller may not list every wallet (403)', async () => {
    const res = await request('GET', '/wallet/admin/wallets', { user: SELLER_A, role: 'SELLER' });
    assert.strictEqual(res.status, 403);
  });

  it('an admin may read the platform financial summary', async () => {
    const order = await seedTwoSellerOrder();
    await postWebhook({
      idempotencyKey: 'idem-fin-1', orderId: String(order._id),
      transactionId: 'txn-fin-1', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const res = await request('GET', '/wallet/admin/financial-summary', { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.totalCommissionDeducted, 100);
    assert.strictEqual(res.body.data.totalPendingBalance, 900);
  });

  it('a buyer may not read the platform financial summary (403)', async () => {
    const res = await request('GET', '/wallet/admin/financial-summary', { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it('an admin may read the payment reconciliation view', async () => {
    const order = await seedOrder();
    await postWebhook({
      idempotencyKey: 'idem-recon-1', orderId: String(order._id),
      transactionId: 'txn-recon-1', paymentMethod: 'COD', status: 'COMPLETED',
    });
    const res = await request('GET', '/payment/admin/reconciliation', { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 200);
    const row = res.body.rows.find((r) => r.orderId === String(order._id));
    assert.ok(row);
    assert.strictEqual(row.expectedAmount, 600);
    assert.strictEqual(row.paidAmount, 600);
    assert.strictEqual(row.outstandingAmount, 0);
    assert.strictEqual(row.reconciliationStatus, 'MATCHED');
  });

  it('a buyer may not read the admin reconciliation view (403)', async () => {
    const res = await request('GET', '/payment/admin/reconciliation', { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 403);
  });

  it('an admin cannot mark a PENDING payment COMPLETED through the API (no self-reported settlement)', async () => {
    const order = await seedOrder();
    const created = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'COD' },
      user: BUYER, role: 'BUYER',
    });
    const paymentId = created.body.payment._id;

    // There must be no admin route that self-reports a settlement outcome.
    const attempts = [
      ['PUT', `/payment/update-payment-status/${paymentId}`],
      ['PUT', `/payment/admin/payments/${paymentId}/status`],
      ['POST', `/payment/admin/payments/${paymentId}/complete`],
      ['POST', `/payment/confirm-payment/${paymentId}`],
    ];
    for (const [method, path] of attempts) {
      const res = await request(method, path, {
        body: { status: 'COMPLETED' },
        user: ADMIN, role: 'ADMIN',
      });
      assert.notStrictEqual(res.status, 200, `${method} ${path} must not allow a self-reported settlement`);
    }

    const payment = await Payment.findById(paymentId);
    assert.strictEqual(payment.status, 'PENDING', 'the payment must still be PENDING without a provider callback');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PAYMENT METHOD CONFIGURATION & AMOUNT LIMITS
// ─────────────────────────────────────────────────────────────────────────────
describe('7. Payment method configuration and amount limits', () => {
  it('lists methods with sortOrder field', async () => {
    const res = await request('GET', '/payment/admin/methods', { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 200);
    const methods = res.body.methods;
    assert.ok(methods.length >= 4);
    // COD should be first (sortOrder: 1)
    assert.strictEqual(methods[0].key, 'COD');
    assert.strictEqual(methods[0].sortOrder, 1);
    // BANK_TRANSFER should be second (sortOrder: 2)
    assert.strictEqual(methods[1].key, 'BANK_TRANSFER');
    assert.strictEqual(methods[1].sortOrder, 2);
  });

  it('admin can test connection for COD (offline method)', async () => {
    const methodsRes = await request('GET', '/payment/admin/methods', { user: ADMIN, role: 'ADMIN' });
    const codMethod = methodsRes.body.methods.find(m => m.key === 'COD');
    const testRes = await request('POST', `/payment/admin/methods/${codMethod.id}/test`, { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(testRes.status, 200);
    assert.strictEqual(testRes.body.success, true);
    assert.strictEqual(testRes.body.result.success, true);
  });

  it('admin test connection returns 404 for non-existent method', async () => {
    // Use a valid ObjectId that doesn't exist
    const fakeId = '507f1f77bcf86cd799439011';
    const res = await request('POST', `/payment/admin/methods/${fakeId}/test`, { user: ADMIN, role: 'ADMIN' });
    assert.strictEqual(res.status, 404);
  });

  it('enforces minAmount limit on payment creation', async () => {
    // Create an order with amount below Telebirr's minAmount (10)
    const order = await seedOrder({ totalPrice: 5 });
    // First activate Telebirr with minAmount 10
    const PaymentMethod = require('../models/PaymentMethods');
    await PaymentMethod.updateOne({ key: 'TELEBIRR' }, { status: 'ACTIVE', configured: true, minAmount: 10, availableFor: ['BUYERS'] });
    
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'TELEBIRR' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('below minimum'));
  });

  it('enforces maxAmount limit on payment creation', async () => {
    // Create an order with amount above Telebirr's maxAmount (100000)
    const order = await seedOrder({ totalPrice: 150000 });
    const PaymentMethod = require('../models/PaymentMethods');
    await PaymentMethod.updateOne({ key: 'TELEBIRR' }, { status: 'ACTIVE', configured: true, maxAmount: 100000, availableFor: ['BUYERS'] });
    
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'TELEBIRR' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('exceeds maximum'));
  });

  it('allows payment when amount is within limits', async () => {
    const order = await seedOrder({ totalPrice: 5000 });
    const PaymentMethod = require('../models/PaymentMethods');
    await PaymentMethod.updateOne({ key: 'TELEBIRR' }, { status: 'ACTIVE', configured: true, minAmount: 10, maxAmount: 100000, availableFor: ['BUYERS'] });
    
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'TELEBIRR' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.payment.paymentMethod, 'TELEBIRR');
  });

  it('rejects payment for inactive method', async () => {
    const order = await seedOrder();
    const PaymentMethod = require('../models/PaymentMethods');
    await PaymentMethod.updateOne({ key: 'TELEBIRR' }, { status: 'INACTIVE', configured: true, availableFor: ['BUYERS'] });
    
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'TELEBIRR' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('not active'));
  });

  it('rejects payment for method not available for buyers', async () => {
    const order = await seedOrder();
    const PaymentMethod = require('../models/PaymentMethods');
    await PaymentMethod.updateOne({ key: 'TELEBIRR' }, { status: 'ACTIVE', configured: true, availableFor: ['SELLERS'] });
    
    const res = await request('POST', '/payment/create-payment', {
      body: { orderId: String(order._id), paymentMethod: 'TELEBIRR' },
      user: BUYER, role: 'BUYER',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('not available for buyers'));
  });

  it('get-active-methods returns methods sorted by sortOrder', async () => {
    const res = await request('GET', '/payment/get-active-methods', { user: BUYER, role: 'BUYER' });
    assert.strictEqual(res.status, 200);
    const methods = res.body.methods;
    // COD should be first
    assert.strictEqual(methods[0].key, 'COD');
    // Check sortOrder is present
    assert.ok(methods.every(m => typeof m.sortOrder === 'number'));
  });
});
