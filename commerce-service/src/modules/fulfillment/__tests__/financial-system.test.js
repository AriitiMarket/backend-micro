/**
 * FINANCIAL SYSTEM INTEGRATION TESTS - Part 1
 */
const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');

const DB_URL = (process.env.MONGODB_URI || 'mongodb://localhost:27017/ariti_commerce_test_financial') + '?directConnection=true&retryWrites=false';

let SellerWallet, WalletTransaction, SellerAllocation, Order, CommissionLedger;
let walletsService, payoutsService, allocationService, commissionLedgerService;
let ORDER_STATUSES;

const oid = () => new mongoose.Types.ObjectId().toString();

async function seedWallet(sellerId, overrides = {}) {
  SellerWallet = SellerWallet || require('../models/SellerWallet');
  const walletRepo = require('../repositories/wallets.repository');
  const wallet = await SellerWallet.create({
    sellerId, availableBalance: 0, pendingBalance: 0,
    totalEarned: 0, totalCommissionDeducted: 0, currency: 'ETB', status: 'ACTIVE',
  });
  if (overrides.availableBalance !== undefined || overrides.pendingBalance !== undefined) {
    await walletRepo.updateWalletBalances(wallet._id, {
      availableBalance: overrides.availableBalance || 0,
      pendingBalance: overrides.pendingBalance || 0,
    });
  }
  if (overrides.totalEarned !== undefined) wallet.totalEarned = overrides.totalEarned;
  if (overrides.totalCommissionDeducted !== undefined) wallet.totalCommissionDeducted = overrides.totalCommissionDeducted;
  if (overrides.totalRefunded !== undefined) wallet.totalRefunded = overrides.totalRefunded;
  if (overrides.totalPaidOut !== undefined) wallet.totalPaidOut = overrides.totalPaidOut;
  if (overrides.totalAdjusted !== undefined) wallet.totalAdjusted = overrides.totalAdjusted;
  return wallet;}
async function seedOrder(overrides = {}) {
  Order = Order || require('../models/Orders');
  return Order.create({
    cart: [{ _id: 'p-1', productId: 'p-1', name: 'Widget', quantity: 2, qty: 2, discountPrice: 100, price: 100, subtotal: 200 }],
    user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' }, buyerId: 'buyer-1',
    subtotal: 200, shippingFee: 6, currency: 'ETB', totalPrice: 206,
    paymentStatus: 'CONFIRMED', status: ORDER_STATUSES.CONFIRMED,
    sellerId: 'seller-1',
    sellerShipments: [{ sellerId: 'seller-1', shopId: 'shop-1', items: [{ name: 'Widget', quantity: 2, subtotal: 200 }], subtotal: 200 }],
    ...overrides,
  });
}

async function seedMultiSellerOrder(overrides = {}) {
  Order = Order || require('../models/Orders');
  const groupId = 'group-test-' + oid();
  return Order.create({
    cart: [
      { _id: 'p-1', productId: 'p-1', name: 'Widget A', quantity: 1, qty: 1, discountPrice: 100, price: 100, subtotal: 100 },
      { _id: 'p-2', productId: 'p-2', name: 'Widget B', quantity: 1, qty: 1, discountPrice: 200, price: 200, subtotal: 200 },
    ],
    user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' }, buyerId: 'buyer-1',
    subtotal: 300, shippingFee: 9, currency: 'ETB', totalPrice: 309,
    paymentStatus: 'CONFIRMED', status: ORDER_STATUSES.CONFIRMED,
    orderGroupId: groupId, sellerId: 'seller-1',
    sellerShipments: [
      { sellerId: 'seller-1', shopId: 'shop-1', items: [{ name: 'Widget A', quantity: 1, subtotal: 100 }], subtotal: 100 },
      { sellerId: 'seller-2', shopId: 'shop-2', items: [{ name: 'Widget B', quantity: 1, subtotal: 200 }], subtotal: 200 },
    ],
    ...overrides,
  });
}

// The database connection lifecycle is hoisted to FILE scope on purpose.
//
// Sections 2-6 below are SIBLING top-level suites that share the same mongoose
// connection. When the lifecycle lived inside the first suite, its `after()`
// closed the connection as soon as section 1 finished, and every test after
// that failed with "Client must be connected before running operations" — the
// whole file (payouts, refunds, multi-seller allocation, commission) was
// silently unrunnable and was not part of the npm test script.
before(async () => {
  await mongoose.connect(DB_URL);
  // Wait for connection to be established
  await new Promise((resolve) => {
    if (mongoose.connection.readyState === 1) return resolve();
    mongoose.connection.once('open', resolve);
    mongoose.connection.once('error', resolve);
  });
  ORDER_STATUSES = require('../constants/orderStatuses').ORDER_STATUSES;
  SellerWallet = require('../models/SellerWallet');
  WalletTransaction = require('../models/WalletTransaction');
  SellerAllocation = require('../models/SellerAllocation');
  Order = require('../models/Orders');
  CommissionLedger = require('../models/CommissionLedger');
  await Promise.all([
    SellerWallet.deleteMany({}), WalletTransaction.deleteMany({}),
    SellerAllocation.deleteMany({}), Order.deleteMany({}),
    CommissionLedger.deleteMany({}),
  ]);
  await Promise.all([
    SellerWallet.init(), WalletTransaction.init(),
    SellerAllocation.init(), Order.init(), CommissionLedger.init(),
  ]);
  walletsService = require('../services/wallets.service');
  payoutsService = require('../services/payouts.service');
  allocationService = require('../services/allocation.service');
  commissionLedgerService = require('../services/commissionLedger.service');
});

beforeEach(async () => {
  // Ensure connection is alive before each test
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(DB_URL);
  }
});

afterEach(async () => {
  try {
    await Promise.all([
      SellerWallet.deleteMany({}), WalletTransaction.deleteMany({}),
      SellerAllocation.deleteMany({}), Order.deleteMany({}),
      CommissionLedger.deleteMany({}),
    ]);
  } catch (e) {
    // If connection dropped, reconnect for next test
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(DB_URL);
    }
  }
});

// Close the shared connection only once EVERY suite in this file has run.
after(async () => { await mongoose.connection.close(); });

describe('Financial System', () => {

  describe('1. Seller Wallet & Ledger', () => {
    it('should create wallet with zero balances', async () => {
      const wallet = await walletsService.getOrCreateWallet('seller-test-1');
      assert.strictEqual(wallet.availableBalance, 0);
      assert.strictEqual(wallet.pendingBalance, 0);
      assert.strictEqual(wallet.sellerId, 'seller-test-1');
      assert.strictEqual(wallet.status, 'ACTIVE');
    });

    it('should credit pending balance on order allocation with actor logging', async () => {
      const wallet = await seedWallet('seller-alloc-1');
      const order = await seedOrder({ sellerId: 'seller-alloc-1' });
      const [alloc] = await allocationService.allocateOrder(order, { id: 'admin-1', role: 'ADMIN' });
      assert.strictEqual(alloc.commissionRate, 10);
      const result = await walletsService.creditFromAllocation(
        String(order._id), 'seller-alloc-1',
        { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
          netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
          allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
        { actor: 'admin-1', actorType: 'ADMIN' }
      );
      assert.ok(result.wallet.pendingBalance > 0);
      assert.strictEqual(result.wallet.totalCommissionDeducted, alloc.platformCommission);
      const txns = await WalletTransaction.find({ sellerId: 'seller-alloc-1' });
      assert.strictEqual(txns.length, 1);
      assert.strictEqual(txns[0].transactionType, 'ORDER_ALLOCATION');
      assert.strictEqual(txns[0].direction, 'CREDIT');
      assert.strictEqual(String(txns[0].actor), 'admin-1');
      assert.strictEqual(txns[0].actorType, 'ADMIN');
      assert.ok(txns[0].transactionAt instanceof Date);
    });

    it('should reject double-crediting same order allocation', async () => {
      const wallet = await seedWallet('seller-double-1');
      const order = await seedOrder({ sellerId: 'seller-double-1' });
      const [alloc] = await allocationService.allocateOrder(order);
      await walletsService.creditFromAllocation(
        String(order._id), 'seller-double-1',
        { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
          netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
          allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
        { actor: 'system', actorType: 'SYSTEM' }
      );
      await assert.rejects(
        () => walletsService.creditFromAllocation(
          String(order._id), 'seller-double-1',
          { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
            netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
            allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
          { actor: 'system', actorType: 'SYSTEM' }
        ),
        (err) => err.statusCode === 409 && /already credited/.test(err.message)
      );
    });

    it('should enforce no negative available balance on debit', async () => {
      const wallet = await seedWallet('seller-neg-1', { availableBalance: 100 });
      await assert.rejects(
        () => walletsService.creditRefund(wallet._id, 500, 'order-neg-1', {
          actor: 'admin-1', actorType: 'ADMIN', reason: 'Refund'
        }),
        (err) => err.statusCode === 400 && /Insufficient/.test(err.message)
      );
    });

    it('should release pending balance to available', async () => {
      const wallet = await seedWallet('seller-release-1', { pendingBalance: 500 });
      const result = await walletsService.releasePendingBalance(
        wallet._id, 500,
        { actor: null, actorType: 'SYSTEM', reason: 'Settlement window complete' }
      );
      assert.strictEqual(result.wallet.availableBalance, 500);
      assert.strictEqual(result.wallet.pendingBalance, 0);
    });

    it('should record manual admin adjustment with actor', async () => {
      const wallet = await seedWallet('seller-adj-1', { availableBalance: 1000 });
      const result = await walletsService.createAdjustment(
        wallet._id, -200, 'Penalty for late delivery',
        { actor: 'admin-1', actorType: 'ADMIN' }
      );
      assert.strictEqual(result.wallet.availableBalance, 800);
      assert.strictEqual(result.wallet.totalAdjusted, -200);
      const txns = await WalletTransaction.find({ sellerId: 'seller-adj-1' });
      assert.strictEqual(txns.length, 1);
      assert.strictEqual(txns[0].transactionType, 'ADJUSTMENT');
      assert.strictEqual(txns[0].direction, 'DEBIT');
      assert.strictEqual(String(txns[0].actor), 'admin-1');
      assert.strictEqual(txns[0].actorType, 'ADMIN');
    });

    it('should make wallet transactions immutable', async () => {
      const txn = await WalletTransaction.create({
        sellerId: new mongoose.Types.ObjectId(), transactionType: 'ORDER_ALLOCATION',
        amount: 100, currency: 'ETB', direction: 'CREDIT', status: 'COMPLETED',
        reason: 'Test', actorType: 'SYSTEM', transactionAt: new Date(),
      });
      await assert.rejects(
        () => WalletTransaction.updateOne({ _id: txn._id }, { amount: 9999 }),
        (err) => /immutable/.test(err.message)
      );
    });
  });

});

// ── 2. Multi-Seller Orders & Splits ────────────────────────────────────
describe('2. Multi-Seller Orders & Splits', () => {
  it('should compute proportional allocation per seller with commission', async () => {
    const order = await seedMultiSellerOrder();
    const allocs = await allocationService.allocateOrder(order, { id: 'system', role: 'SYSTEM' });
    assert.strictEqual(allocs.length, 2);
    const s1 = allocs.find(a => a.sellerId === 'seller-1');
    const s2 = allocs.find(a => a.sellerId === 'seller-2');
    assert.strictEqual(s1.grossSubtotal, 100);
    assert.strictEqual(s1.platformCommission, 10);
    assert.strictEqual(s1.netPayable, 99);
    assert.strictEqual(s1.commissionRate, 10);
    assert.strictEqual(s2.grossSubtotal, 200);
    assert.strictEqual(s2.platformCommission, 20);
    assert.strictEqual(s2.netPayable, 189);
    assert.strictEqual(s2.commissionRate, 10);
    const totalCommission = s1.platformCommission + s2.platformCommission;
    assert.strictEqual(totalCommission, 30);
  });

  it('should be idempotent - duplicate allocation does not duplicate money', async () => {
    const order = await seedMultiSellerOrder();
    const allocs1 = await allocationService.allocateOrder(order);
    const allocs2 = await allocationService.allocateOrder(order);
    assert.strictEqual(allocs1.length, 2);
    assert.strictEqual(allocs2.length, 2);
    assert.strictEqual(String(allocs1[0]._id), String(allocs2[0]._id));
    assert.strictEqual(String(allocs1[1]._id), String(allocs2[1]._id));
    const count = await SellerAllocation.countDocuments({ orderId: String(order._id) });
    assert.strictEqual(count, 2);
  });

  it('should snapshot commission rate on allocation', async () => {
    const order = await seedMultiSellerOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    assert.strictEqual(alloc.commissionRate, 10);
    const stored = await SellerAllocation.findById(alloc._id);
    assert.strictEqual(stored.commissionRate, 10);
  });

  it('should credit wallets for all sellers in multi-seller order', async () => {
    const order = await seedMultiSellerOrder();
    const allocs = await allocationService.allocateOrder(order);
    for (const alloc of allocs) {
      await walletsService.creditFromAllocation(
        String(order._id), String(alloc.sellerId),
        { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
          netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
          allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
        { actor: 'system', actorType: 'SYSTEM' }
      );
    }
    const w1 = await walletsService.getSellerWallet('seller-1');
    const w2 = await walletsService.getSellerWallet('seller-2');
    assert.strictEqual(w1.pendingBalance, 99);
    assert.strictEqual(w2.pendingBalance, 189);
  });
});

// ── 3. Payout Workflow ─────────────────────────────────────────────────
describe('3. Payout Workflow', () => {
  it('should request payout and auto-deduct from available balance', async () => {
    const wallet = await seedWallet('seller-payout-1', { availableBalance: 5000 });
    const result = await payoutsService.requestPayout(
      'seller-payout-1', 1000, 'BANK_TRANSFER', { accountNumber: '1234567890' }
    );
    assert.strictEqual(result.payoutRequest.status, 'PENDING');
    assert.strictEqual(result.deductedAmount, 1000);
    assert.strictEqual(result.processingFee, 10);
    assert.strictEqual(result.netPayoutAmount, 990);
    assert.strictEqual(result.remainingBalance, 4000);
    const updatedWallet = await walletsService.getSellerWallet('seller-payout-1');
    assert.strictEqual(updatedWallet.availableBalance, 4000);
  });

  it('should reject payout exceeding available balance', async () => {
    const wallet = await seedWallet('seller-payout-2', { availableBalance: 100 });
    await assert.rejects(
      () => payoutsService.requestPayout('seller-payout-2', 500, 'BANK_TRANSFER', {}),
      (err) => err.statusCode === 400 && /Insufficient/.test(err.message)
    );
  });

  it('should admin approve payout', async () => {
    const wallet = await seedWallet('seller-payout-3', { availableBalance: 5000 });
    const result = await payoutsService.requestPayout(
      'seller-payout-3', 1000, 'BANK_TRANSFER', {}
    );
    const approved = await payoutsService.approvePayout(result.payoutRequest._id, 'admin-1', 'Verified');
    assert.strictEqual(approved.status, 'APPROVED');
    assert.strictEqual(String(approved.approvedBy), 'admin-1');
  });

  it('should admin complete payout with external transaction ID', async () => {
    const wallet = await seedWallet('seller-payout-4', { availableBalance: 5000 });
    const result = await payoutsService.requestPayout('seller-payout-4', 1000, 'BANK_TRANSFER', {});
    await payoutsService.approvePayout(result.payoutRequest._id, 'admin-1');
    const completed = await payoutsService.completePayout(
      result.payoutRequest._id, 'txn_ext_12345', { provider: 'bank', status: 'success' }, 'admin-1'
    );
    // completePayout returns the payout document itself (the controller reads
    // `payout._id` / `payout.status` straight off it), unlike rejectPayout
    // which returns a { payout, ... } envelope.
    assert.strictEqual(completed.status, 'COMPLETED');
    assert.strictEqual(completed.transactionId, 'txn_ext_12345');
    const updatedWallet = await walletsService.getSellerWallet('seller-payout-4');
    // The payout pays the NET amount: the requested amount minus the platform's
    // processing fee (see payouts.service.js: netPayoutAmount = amount - fee).
    assert.strictEqual(updatedWallet.totalPaidOut, result.netPayoutAmount);
    assert.strictEqual(updatedWallet.totalPaidOut, 990);
  });

  it('should refund failed payout back to available balance', async () => {
    const wallet = await seedWallet('seller-payout-5', { availableBalance: 5000 });
    const result = await payoutsService.requestPayout('seller-payout-5', 1000, 'BANK_TRANSFER', {});
    await payoutsService.approvePayout(result.payoutRequest._id, 'admin-1');
    const beforeWallet = await walletsService.getSellerWallet('seller-payout-5');
    assert.strictEqual(beforeWallet.availableBalance, 4000);
    const failed = await payoutsService.failPayout(
      result.payoutRequest._id, 'Insufficient funds in bank account',
      null, { error: 'insufficient_funds' }, 'admin-1'
    );
    assert.strictEqual(failed.payout.status, 'FAILED');
    const afterWallet = await walletsService.getSellerWallet('seller-payout-5');
    assert.strictEqual(afterWallet.availableBalance, 5000);
    const txns = await WalletTransaction.find({
      sellerId: 'seller-payout-5', transactionType: 'PAYOUT_FAILED',
    });
    assert.strictEqual(txns.length, 1);
    assert.strictEqual(txns[0].direction, 'CREDIT');
    assert.strictEqual(txns[0].amount, 1000);
    assert.strictEqual(String(txns[0].actor), 'admin-1');
  });

  it('should reject payout and return funds', async () => {
    const wallet = await seedWallet('seller-payout-6', { availableBalance: 5000 });
    const result = await payoutsService.requestPayout('seller-payout-6', 1000, 'BANK_TRANSFER', {});
    const rejected = await payoutsService.rejectPayout(result.payoutRequest._id, 'Invalid account details', 'admin-1');
    assert.strictEqual(rejected.payout.status, 'REJECTED');
    assert.strictEqual(rejected.payout.rejectionReason, 'Invalid account details');
    const updatedWallet = await walletsService.getSellerWallet('seller-payout-6');
    assert.strictEqual(updatedWallet.availableBalance, 5000);
  });

  it('should enforce minimum payout amount', async () => {
    await seedWallet('seller-payout-7', { availableBalance: 5000 });
    await assert.rejects(
      () => payoutsService.requestPayout('seller-payout-7', 10, 'BANK_TRANSFER', {}),
      (err) => err.statusCode === 400 && /Minimum/.test(err.message)
    );
  });
});

// ── 4. Refund with Proportional Commission Reversal ────────────────────
describe('4. Refund with Commission Reversal', () => {
  it('should reverse platform commission proportionally on refund', async () => {
    const order = await seedMultiSellerOrder();
    const [alloc] = await allocationService.allocateOrder(order);
    const updated = await allocationService.refundAllocation(
      alloc._id, { amount: 45, reason: 'Partial return', actor: { id: 'admin-1', role: 'ADMIN' } }
    );
    assert.strictEqual(updated.refundAmount, 45);
    assert.ok(updated.platformCommission < 10, 'Commission should be reduced');
    assert.ok(updated.platformCommission >= 5, 'Commission should not be zero');
    // netPayable = grossSubtotal 100 + shippingFee 9 - commission 5.5 - refund 45.
    // Shipping is passed through to the seller and is NOT commissioned, so it
    // IS part of the net payable (see models/SellerAllocation.js and the
    // matching expectation in allocation.test.js).
    assert.strictEqual(updated.netPayable, 100 + 9 - 5.5 - 45);
  });

  it('should fully reverse commission on full refund', async () => {
    const order = await seedOrder({ sellerId: 'seller-full-refund' });
    const [alloc] = await allocationService.allocateOrder(order);
    const updated = await allocationService.refundAllocation(
      alloc._id, { amount: alloc.netPayable, reason: 'Full return', actor: { id: 'admin-1', role: 'ADMIN' } }
    );
    assert.strictEqual(updated.refundAmount, alloc.netPayable);
    assert.strictEqual(updated.status, 'REFUNDED');
    assert.strictEqual(updated.platformCommission, 0);
  });

  it('should reject refund exceeding net payable', async () => {
    const order = await seedOrder({ sellerId: 'seller-over-refund' });
    const [alloc] = await allocationService.allocateOrder(order);
    await assert.rejects(
      () => allocationService.refundAllocation(
        alloc._id, { amount: alloc.netPayable + 100, reason: 'Over refund' }
      ),
      (err) => err.statusCode === 400 && /exceeds net payable/.test(err.message)
    );
  });

  it('should credit refund from wallet with actor logging', async () => {
    const wallet = await seedWallet('seller-refund-wallet', { availableBalance: 1000, pendingBalance: 500 });
    const result = await walletsService.creditRefund(
      wallet._id, 300, 'order-refund-1',
      { actor: 'admin-1', actorType: 'ADMIN', reason: 'Buyer return refund' }
    );
    assert.strictEqual(result.wallet.pendingBalance, 200);
    assert.strictEqual(result.wallet.availableBalance, 1000);
    assert.strictEqual(result.wallet.totalRefunded, 300);
    const txns = await WalletTransaction.find({ sellerId: 'seller-refund-wallet' });
    assert.strictEqual(txns[0].transactionType, 'REFUND_CREDITED');
    assert.strictEqual(txns[0].direction, 'DEBIT');
    assert.strictEqual(String(txns[0].actor), 'admin-1');
  });
});

// ── 5. Balance Constraints ─────────────────────────────────────────────
describe('5. Balance Constraints', () => {
  it('should prevent wallet from going negative via payout', async () => {
    // The balance must cover the platform's minimum payout (500 ETB), so the
    // request below is refused for INSUFFICIENT BALANCE rather than for
    // being under the minimum — that is what this test is about.
    const wallet = await seedWallet('seller-constraint-1', { availableBalance: 1000 });
    const result = await payoutsService.requestPayout('seller-constraint-1', 1000, 'BANK_TRANSFER', {});
    assert.strictEqual(result.remainingBalance, 0);
    await assert.rejects(
      () => payoutsService.requestPayout('seller-constraint-1', 1000, 'BANK_TRANSFER', {}),
      (err) => err.statusCode === 400
    );
  });

  it('should prevent over-refund beyond available+pending balance', async () => {
    const wallet = await seedWallet('seller-over-refund', { availableBalance: 100, pendingBalance: 100 });
    await assert.rejects(
      () => walletsService.creditRefund(wallet._id, 300, 'order-over-refund', { actor: 'admin-1', actorType: 'ADMIN' }),
      (err) => err.statusCode === 400 && /Insufficient/.test(err.message)
    );
  });

  it('should prevent negative adjustment beyond available balance', async () => {
    const wallet = await seedWallet('seller-neg-adj', { availableBalance: 50 });
    await assert.rejects(
      () => walletsService.createAdjustment(wallet._id, -100, 'Excessive penalty', { actor: 'admin-1', actorType: 'ADMIN' }),
      (err) => err.statusCode === 400 && /Insufficient/.test(err.message)
    );
  });
});

// ── 6. Dynamic Commission Management ───────────────────────────────────
describe('6. Dynamic Commission Management', () => {
  it('should support per-seller commission rate overrides', async () => {
    const settingsService = require('../../platform/services/settings.service');
    await settingsService.updatePlatformSettings({
      commissionRate: 10, sellerCommissionRates: { 'seller-tier-1': 5, 'seller-tier-2': 15 },
    });
    Order = require('../models/Orders');
    const order = await Order.create({
      cart: [
        { _id: 'p-1', productId: 'p-1', name: 'Tier 1 Item', quantity: 1, qty: 1, discountPrice: 100, price: 100, subtotal: 100 },
        { _id: 'p-2', productId: 'p-2', name: 'Tier 2 Item', quantity: 1, qty: 1, discountPrice: 200, price: 200, subtotal: 200 },
      ],
      user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' }, buyerId: 'buyer-1',
      subtotal: 300, shippingFee: 9, currency: 'ETB', totalPrice: 309,
      paymentStatus: 'CONFIRMED', status: ORDER_STATUSES.CONFIRMED,
      orderGroupId: 'group-tier-test', sellerId: 'seller-tier-1',
      sellerShipments: [
        { sellerId: 'seller-tier-1', shopId: 'shop-1', items: [{ name: 'Tier 1', quantity: 1, subtotal: 100 }], subtotal: 100 },
        { sellerId: 'seller-tier-2', shopId: 'shop-2', items: [{ name: 'Tier 2', quantity: 1, subtotal: 200 }], subtotal: 200 },
      ],
    });
    const allocs = await allocationService.allocateOrder(order);
    const t1 = allocs.find(a => a.sellerId === 'seller-tier-1');
    const t2 = allocs.find(a => a.sellerId === 'seller-tier-2');
    assert.strictEqual(t1.commissionRate, 5);
    assert.strictEqual(t1.platformCommission, 5);
    assert.strictEqual(t2.commissionRate, 15);
    assert.strictEqual(t2.platformCommission, 30);
  });

  it('should fall back to global default rate when no per-seller override', async () => {
    const order = await seedOrder({ sellerId: 'seller-default-rate' });
    const [alloc] = await allocationService.allocateOrder(order);
    assert.strictEqual(alloc.commissionRate, 10);
    assert.strictEqual(alloc.platformCommission, 20);
  });

  it('should preserve commission rate snapshot in ledger', async () => {
    const order = await seedOrder({ sellerId: 'seller-snapshot' });
    const [alloc] = await allocationService.allocateOrder(order);
    await commissionLedgerService.logCommission(
      String(order._id), 'seller-snapshot',
      { grossSubtotal: alloc.grossSubtotal, platformCommission: alloc.platformCommission,
        netPayable: alloc.netPayable, commissionRate: alloc.commissionRate,
        allocationId: String(alloc._id), reason: 'ORDER_CONFIRMED' },
      { actorId: 'admin-1', actorRole: 'ADMIN' }
    );
    const ledger = await CommissionLedger.findOne({ orderId: String(order._id) });
    assert.strictEqual(ledger.commissionRate, 10);
    assert.strictEqual(String(ledger.actorId), 'admin-1');
    assert.strictEqual(ledger.actorRole, 'ADMIN');
    assert.ok(ledger.timestamp instanceof Date);
  });
});
