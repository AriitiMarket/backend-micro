const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const paymentLedgerService = require('../services/paymentLedger.service');
const paymentLedgerRepository = require('../repositories/paymentLedger.repository');
const paymentRepository = require('../repositories/payments.repository');

const mockSession = {
  startTransaction: () => {},
  commitTransaction: () => Promise.resolve(),
  abortTransaction: () => Promise.resolve(),
  endSession: () => Promise.resolve(),
};

test('PaymentLedgerService', async t => {
  const originalStartSession = mongoose.startSession;
  mongoose.startSession = () => Promise.resolve(mockSession);

  t.after(() => {
    mongoose.startSession = originalStartSession;
  });

  const paymentId = 'payment123';
  const orderId = 'order123';
  const userId = 'user123';
  const sellerId = 'seller123';

  const testPayment = {
    _id: paymentId,
    orderId,
    userId,
    sellerId,
    amount: 100,
    currency: 'ETB',
    status: 'PENDING',
  };

  await t.test('logPaymentChange logs status transition', async () => {
    paymentRepository.findById = () => Promise.resolve(testPayment);

    const mockEntry = {
      _id: 'ledger123',
      paymentId,
      orderId,
      userId,
      sellerId,
      oldStatus: 'PENDING',
      newStatus: 'COMPLETED',
      amount: 100,
      currency: 'ETB',
      actor: 'SYSTEM',
      timestamp: new Date(),
    };

    paymentLedgerRepository.create = () => Promise.resolve(mockEntry);

    const result = await paymentLedgerService.logPaymentChange(
      paymentId,
      'PENDING',
      'COMPLETED',
      { actorType: 'SYSTEM' }
    );

    assert.strictEqual(result.oldStatus, 'PENDING');
    assert.strictEqual(result.newStatus, 'COMPLETED');
    assert.strictEqual(result.amount, 100);
  });

  await t.test('logPaymentChange throws 404 if payment not found', async () => {
    paymentRepository.findById = () => Promise.resolve(null);

    await assert.rejects(
      () => paymentLedgerService.logPaymentChange(paymentId, 'PENDING', 'COMPLETED'),
      /Payment not found/
    );
  });

  await t.test('getPaymentHistory retrieves payment history sorted', async () => {
    const mockHistory = [
      { _id: 'ledger3', oldStatus: 'PROCESSING', newStatus: 'COMPLETED' },
      { _id: 'ledger2', oldStatus: 'PENDING', newStatus: 'PROCESSING' },
    ];

    paymentLedgerRepository.find = () => Promise.resolve(mockHistory);

    const result = await paymentLedgerService.getPaymentHistory(paymentId);
    assert.strictEqual(result.length, 2);
  });

  await t.test('getOrderPaymentHistory retrieves payment history for order', async () => {
    const mockHistory = [
      { oldStatus: 'PENDING', newStatus: 'COMPLETED' },
    ];

    paymentLedgerRepository.find = () => Promise.resolve(mockHistory);

    const result = await paymentLedgerService.getOrderPaymentHistory(orderId);
    assert.strictEqual(result.length, 1);
  });

  await t.test('auditPayment verifies payment integrity', async () => {
    paymentRepository.findById = () => Promise.resolve({
      ...testPayment,
      status: 'COMPLETED',
    });

    const mockLedger = [
      {
        paymentId,
        oldStatus: 'PENDING',
        newStatus: 'COMPLETED',
        amount: 100,
      },
    ];

    const origGetHistory = paymentLedgerService.getPaymentHistory;
    paymentLedgerService.getPaymentHistory = () => Promise.resolve(mockLedger);

    const result = await paymentLedgerService.auditPayment(paymentId);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.statusMatches, true);
    assert.strictEqual(result.amountsConsistent, true);
    assert.deepStrictEqual(result.issues, []);

    paymentLedgerService.getPaymentHistory = origGetHistory;
  });

  await t.test('auditPayment detects status mismatch', async () => {
    paymentRepository.findById = () => Promise.resolve({
      ...testPayment,
      status: 'COMPLETED',
    });

    const mockLedger = [
      { oldStatus: 'PENDING', newStatus: 'FAILED', amount: 100 },
    ];

    const origGetHistory = paymentLedgerService.getPaymentHistory;
    paymentLedgerService.getPaymentHistory = () => Promise.resolve(mockLedger);

    const result = await paymentLedgerService.auditPayment(paymentId);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.statusMatches, false);
    assert.ok(result.issues.includes('Status mismatch between payment and ledger'));

    paymentLedgerService.getPaymentHistory = origGetHistory;
  });

  await t.test('getFailedPayments retrieves failed payments', async () => {
    const mockFailed = [
      { _id: 'ledger1', newStatus: 'FAILED', amount: 100 },
      { _id: 'ledger2', newStatus: 'FAILED', amount: 50 },
    ];

    paymentLedgerRepository.find = () => Promise.resolve(mockFailed);

    const result = await paymentLedgerService.getFailedPayments();
    assert.strictEqual(result.length, 2);
  });

  await t.test('getLedgerStats calculates stats', async () => {
    const mockTransitions = [
      { newStatus: 'COMPLETED', amount: 100, actorType: 'SYSTEM' },
      { newStatus: 'COMPLETED', amount: 200, actorType: 'SYSTEM' },
      { newStatus: 'FAILED', amount: 50, actorType: 'ADMIN' },
    ];

    const origGetTransitions = paymentLedgerService.getPaymentTransitionsByPeriod;
    paymentLedgerService.getPaymentTransitionsByPeriod = () => Promise.resolve(mockTransitions);

    const result = await paymentLedgerService.getLedgerStats({});
    assert.strictEqual(result.totalTransitions, 3);
    assert.strictEqual(result.totalAmount, 350);
    assert.strictEqual(result.byStatus.COMPLETED, 2);
    assert.strictEqual(result.byStatus.FAILED, 1);

    paymentLedgerService.getPaymentTransitionsByPeriod = origGetTransitions;
  });
});
