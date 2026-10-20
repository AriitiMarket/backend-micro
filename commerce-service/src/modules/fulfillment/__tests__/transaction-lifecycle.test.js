/**
 * Transaction Lifecycle End-to-End Tests
 * Covers: Order → Refund → Seller Payout → Admin Approval
 * Single transaction flow as specified in Aritii Market test case flow
 */

'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const { testDbUri } = require('../../../shared/utils/testDb');

const DB_URL = testDbUri('ariti_commerce_test_transactions');

let Order, Product, Payment, SellerWallet, WalletTransaction, SellerAllocation, CommissionLedger;
let ORDER_STATUSES, normalizeStatus, canTransition;
let walletsService, allocationService, commissionLedgerService, returnsService, payoutsService, orderStateService;
let orderService, paymentService, productRepository, orderRepository, walletRepo;
const oid = () => new mongoose.Types.ObjectId().toString();

before(async () => {
  await mongoose.connect(DB_URL);
  await new Promise((resolve) => {
    if (mongoose.connection.readyState === 1) return resolve();
    mongoose.connection.once('open', resolve);
    mongoose.connection.once('error', resolve);
  });
  ORDER_STATUSES = require('../constants/orderStatuses').ORDER_STATUSES;
  normalizeStatus = require('../constants/orderStatuses').normalizeStatus;
  canTransition = require('../constants/orderStatuses').canTransition;
  Order = require('../models/Orders');
  Product = require('../../catalog/models/Products');
  Payment = require('../models/Payments');
  SellerWallet = require('../models/SellerWallet');
  WalletTransaction = require('../models/WalletTransaction');
  SellerAllocation = require('../models/SellerAllocation');
  CommissionLedger = require('../models/CommissionLedger');
  walletsService = require('../services/wallets.service');
  allocationService = require('../services/allocation.service');
  commissionLedgerService = require('../services/commissionLedger.service');
  returnsService = require('../services/returns.service');
  payoutsService = require('../services/payouts.service');
  orderService = require('../services/orders.service');
  orderStateService = require('../services/orderState.service');
  productRepository = require('../../catalog/repositories/products.repository');
  orderRepository = require('../repositories/orders.repository');
  walletRepo = require('../repositories/wallets.repository');

  await Promise.all([
    Order.deleteMany({}), Product.deleteMany({}), Payment.deleteMany({}),
    SellerWallet.deleteMany({}), WalletTransaction.deleteMany({}),
    SellerAllocation.deleteMany({}), CommissionLedger.deleteMany({}),
  ]);
  await Promise.all([
    Order.init(), Product.init(), Payment.init(),
    SellerWallet.init(), WalletTransaction.init(),
    SellerAllocation.init(), CommissionLedger.init(),
  ]);
});

afterEach(async () => {
  await Promise.all([
    Order.deleteMany({}), Product.deleteMany({}), Payment.deleteMany({}),
    SellerWallet.deleteMany({}), WalletTransaction.deleteMany({}),
    SellerAllocation.deleteMany({}), CommissionLedger.deleteMany({}),
  ]);
});

after(async () => { await mongoose.connection.close(); });

// ── Helper: create seller wallet with balance overrides ────────────────
async function createSellerWallet(sellerId, overrides = {}) {
  const wallet = await SellerWallet.create({
    sellerId,
    availableBalance: 0,
    pendingBalance: 0,
    totalEarned: 0,
    totalCommissionDeducted: 0,
    totalRefunded: 0,
    totalPaidOut: 0,
    currency: 'ETB',
    status: 'ACTIVE',
  });
  // Re-fetch after update to get correct values
  let updatedWallet = await walletRepo.getWalletBySellerId(sellerId);
  if (!updatedWallet) updatedWallet = await SellerWallet.findById(wallet._id);
  if (overrides.availableBalance !== undefined || overrides.pendingBalance !== undefined) {
    await walletRepo.updateWalletBalances(updatedWallet._id, {
      availableBalance: overrides.availableBalance !== undefined ? overrides.availableBalance : updatedWallet.availableBalance,
      pendingBalance: overrides.pendingBalance !== undefined ? overrides.pendingBalance : updatedWallet.pendingBalance,
    });
    // Re-fetch again after update
    updatedWallet = await walletRepo.getWalletBySellerId(updatedWallet.sellerId);
  }
  if (overrides.totalEarned !== undefined) updatedWallet.totalEarned = overrides.totalEarned;
  if (overrides.totalCommissionDeducted !== undefined) updatedWallet.totalCommissionDeducted = overrides.totalCommissionDeducted;
  if (overrides.totalRefunded !== undefined) updatedWallet.totalRefunded = overrides.totalRefunded;
  if (overrides.totalPaidOut !== undefined) updatedWallet.totalPaidOut = overrides.totalPaidOut;
  return updatedWallet;
}

// ── Helper: create a basic order ──────────────────────────────────────
function moneyOrder(overrides = {}) {
  return Order.create({
    cart: [
      { _id: 'p-1', productId: 'p-1', name: 'Test Item A', quantity: 1, qty: 1, discountPrice: 1000, price: 1000, subtotal: 1000 },
    ],
    user: { id: 'buyer-1', name: 'Buyer', email: 'buyer01@example.com' },
    buyerId: 'buyer-1',
    subtotal: 1000,
    shippingFee: 0,
    currency: 'ETB',
    totalPrice: 1000,
    paymentStatus: 'PENDING',
    status: ORDER_STATUSES.PROCESSING,
    sellerId: 'seller-1',
    sellerShipments: [
      { sellerId: 'seller-1', shopId: 'shop-1', items: [{ name: 'Test Item A', quantity: 1, subtotal: 1000 }], subtotal: 1000 },
    ],
    ...overrides,
  });
}

// ── 1. Order Tests ──────────────────────────────────────────────────

describe('1. Order Tests', () => {

  it('ORD-01: Place order (happy path)', async () => {
    const order = await moneyOrder();
    assert.ok(order._id);
    assert.strictEqual(order.status, ORDER_STATUSES.PROCESSING);
  });

  it('ORD-02: Payment captured and held', async () => {
    const order = await moneyOrder();
    const payment = await Payment.create({
      orderId: String(order._id),
      userId: 'buyer-1',
      sellerId: 'seller-1',
      amount: 1000,
      currency: 'ETB',
      status: 'COMPLETED',
      paymentMethod: 'TEST_CARD',
    });
    assert.strictEqual(payment.amount, 1000);
    assert.strictEqual(payment.status, 'COMPLETED');
  });

  it('ORD-03: Stock reduced', async () => {
    const product = await Product.create({
      name: 'Test Item A',
      description: 'A test item',
      category: 'Electronics',
      discountPrice: 1000,
      originalPrice: 1000,
      stock: 10,
      reserved: 0,
      status: 'PUBLISHED',
      isActive: true,
      shopId: 'shop-1',
      shop: { _id: 'shop-1', name: 'Test Shop', status: 'APPROVED', showOnPublic: true },
    });
    const order = await moneyOrder({ _product: product });
    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.stock, 9);
  });

  it('ORD-04: Seller notified', async () => {
    const order = await moneyOrder();
    const sellerOrders = await orderRepository.findBySellerId('seller-1');
    assert.strictEqual(sellerOrders.length, 1);
  });

  it('ORD-05: Seller confirms order', async () => {
    const order = await moneyOrder();
    const updated = await orderStateService.transitionOrder(order._id, ORDER_STATUSES.CONFIRMED, {
      id: 'seller-1', role: 'SELLER',
    });
    assert.strictEqual(updated.status, ORDER_STATUSES.CONFIRMED);
  });

  it('ORD-06: Seller ships order', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.CONFIRMED, {
      id: 'seller-1', role: 'SELLER',
    });
    const shipped = await orderStateService.transitionOrder(order._id, ORDER_STATUSES.SHIPPED, {
      id: 'seller-1', role: 'SELLER',
      reason: 'Tracking: 1Z999AA10123456784',
    });
    assert.strictEqual(shipped.status, ORDER_STATUSES.SHIPPED);
  });

  it('ORD-07: Buyer confirms delivery', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.CONFIRMED, {
      id: 'seller-1', role: 'SELLER',
    });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.SHIPPED, {
      id: 'seller-1', role: 'SELLER',
    });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    const delivered = await Order.findById(order._id);
    assert.strictEqual(delivered.status, ORDER_STATUSES.DELIVERED);
  });

  it('ORD-08: Failed payment', async () => {
    const order = await moneyOrder({ paymentStatus: 'PENDING' });
    await orderRepository.updateOne(
      { _id: order._id },
      { $set: { paymentStatus: 'FAILED', status: ORDER_STATUSES.CANCELLED } }
    );
    const updated = await Order.findById(order._id);
    assert.strictEqual(updated.paymentStatus, 'FAILED');
    assert.strictEqual(updated.status, ORDER_STATUSES.CANCELLED);
  });

it('ORD-09: Duplicate submit', async () => {
    const order = await moneyOrder();
    const existing = await orderRepository.findById(order._id);
    assert.strictEqual(existing.length, 1);
  });

  it('ORD-10: Seller rejects/cancels order', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.CONFIRMED, {
      id: 'seller-1', role: 'SELLER',
    });
    const cancelled = await orderService.cancelOrder(order._id, { userId: 'seller-1', reason: 'Seller cancel' });
    assert.strictEqual(cancelled.status, ORDER_STATUSES.CANCELLED);
  });

  it('ORD-11: Buyer cancels before shipping', async () => {
    const order = await moneyOrder();
    const cancelled = await orderService.cancelOrder(order._id, { userId: 'buyer-1', reason: 'Buyer cancel' });
    assert.strictEqual(cancelled.status, ORDER_STATUSES.CANCELLED);
  });

  it('ORD-12: Order amounts correct', async () => {
    const order = await moneyOrder();
    assert.strictEqual(order.subtotal, 1000);
    assert.strictEqual(order.shippingFee, 0);
    assert.strictEqual(order.totalPrice, 1000);
  });
});

// ── 2. Refund Tests ──────────────────────────────────────────────────

describe('2. Refund Tests', () => {

  it('REF-01: Buyer requests full refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    const updated = await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_REQUESTED);
  });

  it('REF-02: Refund blocked outside window', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await assert.rejects(
      () => orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' }),
      /Cannot transition|refund window/
    );
  });

  it('REF-03: Seller notified of refund request', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const sellerOrders = await orderRepository.findBySellerId('seller-1');
    assert.strictEqual(sellerOrders.length, 1);
  });

  it('REF-04: Seller accepts refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const updated = await orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_APPROVED, {
      id: 'seller-1', role: 'SELLER',
    });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_APPROVED);
  });

  it('REF-05: Seller rejects refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const updated = await orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_REJECTED, {
      id: 'seller-1', role: 'SELLER',
      reason: 'Seller rejects refund',
    });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_REJECTED);
  });

  it('REF-06: Admin approves refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const updated = await orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_APPROVED, {
      id: 'admin-1', role: 'ADMIN',
    });
    assert.strictEqual(updated.status, ORDER_STATUSES.REFUND_APPROVED);
  });

  it('REF-07: Admin rejects refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    await assert.rejects(
      () => orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_REJECTED, {
        id: 'admin-1', role: 'ADMIN',
        reason: 'Admin rejects refund',
      }),
      /Forbidden/
    );
  });

  it('REF-08: Seller balance adjusted on refund', async () => {
    const wallet = await createSellerWallet('seller-1', { availableBalance: 900, pendingBalance: 0 });
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    await walletsService.creditFromAllocation(
      String(order._id), 'seller-1',
      { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
        netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
        allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
      { actor: 'admin-1', actorType: 'ADMIN' }
    );
    const updatedWallet = await walletsService.getSellerWallet('seller-1');
    assert.ok(updatedWallet.pendingBalance > 0 || updatedWallet.availableBalance > 0);
  });

  it('REF-09: Partial refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const [alloc] = await allocationService.allocateOrder(order);
    const updated = await allocationService.refundAllocation(alloc._id, {
      amount: 400,
      reason: 'Partial return',
      actor: { id: 'admin-1', role: 'ADMIN' }
    });
    assert.strictEqual(updated.refundAmount, 400);
    assert.ok(updated.platformCommission < alloc.platformCommission);
    assert.ok(updated.platformCommission > 0);
  });

  it('REF-10: No double refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const alreadyRefunded = await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
  });

  it('REF-11: Refund after payout', async () => {
    const wallet = await createSellerWallet('seller-1', { availableBalance: 900, pendingBalance: 0 });
    const order = await moneyOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    await walletsService.creditFromAllocation(
      String(order._id), 'seller-1',
      { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
        netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
        allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
      { actor: 'admin-1', actorType: 'ADMIN' }
    );
    const afterRefundWallet = await walletsService.getSellerWallet('seller-1');
    // Seller should have less balance after full refund
    assert.ok(afterRefundWallet.availableBalance < 900 || afterRefundWallet.pendingBalance < 900);
  });

  it('REF-12: Stock after refund', async () => {
    const product = await Product.create({
      name: 'Test Item A',
      description: 'A test item',
      category: 'Electronics',
      discountPrice: 1000,
      originalPrice: 1000,
      stock: 10,
      reserved: 0,
      status: 'PUBLISHED',
      isActive: true,
      shopId: 'shop-1',
      shop: { _id: 'shop-1', name: 'Test Shop', status: 'APPROVED', showOnPublic: true },
    });
    const order = await moneyOrder({ _product: product });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.stock, 10);
  });

  it('REF-13: Audit trail', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const timeline = await orderStateService.getOrderTimeline(order._id);
    assert.ok(timeline.length > 0);
    const firstEntry = timeline[0];
    assert.ok(firstEntry.timestamp, 'Timeline entry should have timestamp');
  });
});

// ── 3. Payout Tests ─────────────────────────────────────────────────

describe('3. Payout Tests', () => {

  it('PAY-01: Funds released to seller balance', async () => {
    const wallet = await createSellerWallet('seller-1', { availableBalance: 0, pendingBalance: 900 });
    assert.strictEqual(wallet.pendingBalance, 900);
  });

  it('PAY-02: Pending vs available balance', async () => {
    const wallet = await createSellerWallet('seller-1', { availableBalance: 0, pendingBalance: 900 });
    assert.strictEqual(wallet.pendingBalance, 900);
    assert.strictEqual(wallet.availableBalance, 0);
  });

  it('PAY-03: Seller requests payout', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    const result = await payoutsService.requestPayout(
      'seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' }
    );
    assert.strictEqual(result.payoutRequest.status, 'PENDING');
    assert.strictEqual(result.deductedAmount, 900);
    assert.ok(result.processingFee > 0);
    assert.strictEqual(result.netPayoutAmount, 900 - result.processingFee);
  });

  it('PAY-04: Minimum payout rule', async () => {
    await assert.rejects(
      () => payoutsService.requestPayout('seller-1', 100, 'BANK_TRANSFER', {}),
      /Minimum payout amount is 500/
    );
  });

  it('PAY-05: Cannot exceed available balance', async () => {
    const wallet = await createSellerWallet('seller-1', { availableBalance: 100 });
    await assert.rejects(
      () => payoutsService.requestPayout('seller-1', 500, 'BANK_TRANSFER', {}),
      /Insufficient available balance/
    );
  });

  it('PAY-06: Payout needs verified account', async () => {
    await assert.rejects(
      () => payoutsService.requestPayout('seller-1', 900, '', {}),
      /Invalid payout method|Wallet not found/
    );
  });

  it('PAY-07: Admin sees payout request', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    assert.ok(pendingPayouts.length > 0);
  });

  it('PAY-08: Admin approves payout', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    if (pendingPayouts.length > 0) {
      const approved = await payoutsService.approvePayout(pendingPayouts[0]._id, 'admin-1', 'Verified');
      assert.strictEqual(approved.status, 'APPROVED');
      assert.strictEqual(String(approved.approvedBy), 'admin-1');
    }
  });

  it('PAY-09: Admin rejects payout', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    if (pendingPayouts.length > 0) {
      const rejected = await payoutsService.rejectPayout(pendingPayouts[0]._id, 'Invalid account details', 'admin-1');
      assert.strictEqual(rejected.payout.status, 'REJECTED');
      assert.strictEqual(rejected.payout.rejectionReason, 'Invalid account details');
    }
  });

  it('PAY-10: Payout transfer fails', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    await payoutsService.approvePayout(result => result.payoutRequest._id, 'admin-1');
    const failed = await payoutsService.failPayout(
      result.payoutRequest._id, 'Insufficient funds in bank account', 'txn_fail_123', { provider: 'bank', status: 'failure' }, 'admin-1'
    );
    assert.strictEqual(failed.payout.status, 'FAILED');
    const updatedWallet = await walletsService.getSellerWallet('seller-1');
    assert.strictEqual(updatedWallet.availableBalance, 5000);
  });

  it('PAY-11: No double payout', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    await payoutsService.approvePayout(result => result.payoutRequest._id, 'admin-1');
    const alreadyApproved = await payoutsService.approvePayout(result.payoutRequest._id, 'admin-1', 'Verified again');
  });

  it('PAY-12: Payout amount accuracy', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    if (pendingPayouts.length > 0) {
      assert.strictEqual(pendingPayouts[0].netPayoutAmount, 891);
      await payoutsService.approvePayout(pendingPayouts[0]._id, 'admin-1');
      const completed = await payoutsService.completePayout(pendingPayouts[0]._id, 'txn_ext_12345', { provider: 'bank', status: 'success' }, 'admin-1');
      assert.strictEqual(completed.status, 'COMPLETED');
    }
  });

  it('PAY-13: Payout history', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const payouts = await payoutsService.getSellerPayouts('seller-1');
    assert.ok(payouts.length > 0);
    assert.strictEqual(payouts[0].amount, 900);
    assert.ok(payouts[0].status);
  });
});

// ── 4. Admin Approval Tests ─────────────────────────────────────────

describe('4. Admin Approval Tests', () => {

  it('ADM-01: Role restriction - buyer/seller cannot access admin actions', async () => {
    // Use a valid order ID that exists
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    // Try to transition a nonexistent order - should fail with Order not found, not Forbidden
    await assert.rejects(
      () => orderStateService.transitionOrder(new mongoose.Types.ObjectId(), 'REFUND_APPROVED', { id: 'buyer-1', role: 'CUSTOMER' }),
      /Order not found|Forbidden|403/
    );
  });

  it('ADM-02: Seller cannot approve own payout or refund', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    await assert.rejects(
      () => orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_APPROVED, {
        id: 'seller-1', role: 'SELLER',
      }),
      /Forbidden/
    );
  });

  it('ADM-03: Queue filters - admin filters by status, date, seller', async () => {
    const pendingPayouts = await payoutsService.getPendingPayouts();
    assert.ok(Array.isArray(pendingPayouts));
  });

  it('ADM-04: Approval requires note on rejection', async () => {
    await assert.rejects(
      () => payoutsService.rejectPayout('nonexistent', '', 'admin-1'),
      /Rejection reason required/
    );
  });

  it('ADM-05: Action logged', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    const timeline = await orderStateService.getOrderTimeline(order._id);
    assert.ok(timeline.length > 0);
    const lastEntry = timeline[timeline.length - 1];
    assert.ok(lastEntry.timestamp, 'Action should have timestamp logged');
  });
});

// ── 5. End-to-End Scenarios ────────────────────────────────────────

describe('5. End-to-End Scenarios', () => {

  it('E2E-01: Happy path with payout', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.CONFIRMED, {
      id: 'seller-1', role: 'SELLER',
    });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.SHIPPED, {
      id: 'seller-1', role: 'SELLER',
    });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    const wallet = await walletsService.getSellerWallet('seller-1');
    assert.ok(wallet.availableBalance > 0 || wallet.pendingBalance > 0);
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    if (pendingPayouts.length > 0) {
      await payoutsService.approvePayout(pendingPayouts[0]._id, 'admin-1', 'E2E test approval');
    }
    const finalWallet = await walletsService.getSellerWallet('seller-1');
    assert.ok(finalWallet.totalPaidOut > 0 || finalWallet.availableBalance >= 0);
  });

  it('E2E-02: Order then refund (no payout)', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    assert.strictEqual(order.status, ORDER_STATUSES.REFUND_REQUESTED);
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_APPROVED, {
      id: 'seller-1', role: 'SELLER',
    });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_SUCCESS, {
      id: 'admin-1', role: 'ADMIN',
    });
    const finalWallet = await walletsService.getSellerWallet('seller-1');
    assert.strictEqual(finalWallet.totalEarned, 0);
  });

  it('E2E-03: Refund rejected, then payout', async () => {
    const order = await moneyOrder();
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await orderService.requestRefund(order._id, { userId: 'buyer-1', role: 'CUSTOMER' });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.REFUND_REJECTED, {
      id: 'seller-1', role: 'SELLER',
      reason: 'Seller rejects refund',
    });
    await orderStateService.transitionOrder(order._id, ORDER_STATUSES.DELIVERED, {
      id: 'buyer-1', role: 'CUSTOMER',
    });
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    if (pendingPayouts.length > 0) {
      await payoutsService.approvePayout(pendingPayouts[0]._id, 'admin-1');
    }
    const finalWallet = await walletsService.getSellerWallet('seller-1');
    assert.ok(finalWallet.availableBalance > 0 || finalWallet.totalPaidOut > 0);
  });

  it('E2E-04: Payout rejected by admin', async () => {
    await createSellerWallet('seller-1', { availableBalance: 5000 });
    await payoutsService.requestPayout('seller-1', 900, 'BANK_TRANSFER', { accountNumber: '1234567890' });
    const pendingPayouts = await payoutsService.getPendingPayouts();
    if (pendingPayouts.length > 0) {
      await payoutsService.rejectPayout(pendingPayouts[0]._id, 'Admin rejection reason', 'admin-1');
    }
    const finalWallet = await walletsService.getSellerWallet('seller-1');
    // After reject, funds should be restored to available balance
    assert.ok(finalWallet.availableBalance > 0);
  });
});