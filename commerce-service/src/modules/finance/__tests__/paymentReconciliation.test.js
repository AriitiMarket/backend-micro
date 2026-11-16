const test = require('node:test');
const assert = require('node:assert');
const paymentReconciliationService = require('../services/paymentReconciliation.service');
const paymentLedgerService = require('../services/paymentLedger.service');
const paymentRepository = require('../repositories/payments.repository');

test('PaymentReconciliationService', async t => {
  await t.test('reconcileWithProvider matches transactions', async () => {
    const txnList = [
      { id: 'txn1', amount: 100 },
      { id: 'txn2', amount: 200 },
    ];

    let callCount = 0;
    paymentRepository.findOne = () => {
      callCount++;
      return Promise.resolve(callCount === 1
        ? { _id: 'pay1', amount: 100, status: 'SUCCESS' }
        : { _id: 'pay2', amount: 200, status: 'SUCCESS' }
      );
    };

    const result = await paymentReconciliationService.reconcileWithProvider('STRIPE', txnList);

    assert.strictEqual(result.results.matched.length, 2);
    assert.strictEqual(result.results.unmatched.length, 0);
    assert.strictEqual(result.summary.matched, 2);
  });

  await t.test('reconcileWithProvider flags unmatched transactions', async () => {
    const txnList = [{ id: 'txn1', amount: 100 }];

    paymentRepository.findOne = () => Promise.resolve(null);

    const result = await paymentReconciliationService.reconcileWithProvider('STRIPE', txnList);

    assert.strictEqual(result.results.unmatched.length, 1);
    assert.strictEqual(result.results.unmatched[0].transactionId, 'txn1');
  });

  await t.test('reconcileWithProvider detects amount discrepancies', async () => {
    const txnList = [{ id: 'txn1', amount: 200 }];

    paymentRepository.findOne = () => Promise.resolve({
      _id: 'pay1',
      amount: 100,
      status: 'SUCCESS',
    });

    const result = await paymentReconciliationService.reconcileWithProvider('STRIPE', txnList);

    assert.strictEqual(result.results.discrepancies.length, 1);
    assert.strictEqual(result.results.discrepancies[0].difference, 100);
  });

  await t.test('reconcileWithProvider throws error if list empty', async () => {
    try {
      await paymentReconciliationService.reconcileWithProvider('STRIPE', []);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Transaction list required');
    }
  });

  await t.test('getReconciliationReport generates report', async () => {
    const mockLedger = [
      { _id: 'l1', transactionId: 'txn1' },
      { _id: 'l2', transactionId: 'txn2' },
      { _id: 'l3' },
    ];

    paymentLedgerService.getPaymentTransitionsByPeriod = () => Promise.resolve(mockLedger);

    const result = await paymentReconciliationService.getReconciliationReport('day');

    assert.strictEqual(result.period, 'day');
    assert.strictEqual(result.totalEntries, 3);
    assert.strictEqual(result.reconciled, 2);
    assert.strictEqual(result.unreconciled, 1);
  });

  await t.test('flagDiscrepancy sets UNDER_REVIEW status', async () => {
    paymentRepository.findById = () => Promise.resolve({ _id: 'pay1', amount: 100 });

    const result = await paymentReconciliationService.flagDiscrepancy('pay1', 'Amount mismatch');

    assert.strictEqual(result.flagged, true);
    assert.strictEqual(result.status, 'UNDER_REVIEW');
  });

  await t.test('resolveDiscrepancy requires valid action', async () => {
    try {
      await paymentReconciliationService.resolveDiscrepancy('pay1', 'INVALID');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Invalid action');
    }
  });

  await t.test('resolveDiscrepancy supports all valid actions', async () => {
    const validActions = ['APPROVE', 'ADJUST', 'REFUND', 'INVESTIGATE'];

    for (const action of validActions) {
      const result = await paymentReconciliationService.resolveDiscrepancy('pay1', action);
      assert.strictEqual(result.action, action);
    }
  });
});
