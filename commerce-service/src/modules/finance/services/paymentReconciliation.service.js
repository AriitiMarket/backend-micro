const paymentLedgerService = require('./paymentLedger.service');
const paymentRepository = require('../repositories/payments.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class PaymentReconciliationService {
  async reconcileWithProvider(provider, transactionList = []) {
    if (!transactionList || transactionList.length === 0) {
      throw new ApiError('Transaction list required', 400);
    }

    const results = {
      matched: [],
      unmatched: [],
      discrepancies: [],
    };

    for (const txn of transactionList) {
      const payment = await paymentRepository.findOne({
        transactionId: txn.id,
      });

      if (!payment) {
        results.unmatched.push({
          transactionId: txn.id,
          amount: txn.amount,
          reason: 'No matching payment in database',
        });
        continue;
      }

      if (payment.amount !== txn.amount) {
        results.discrepancies.push({
          transactionId: txn.id,
          dbAmount: payment.amount,
          providerAmount: txn.amount,
          difference: txn.amount - payment.amount,
        });
        continue;
      }

      results.matched.push({
        transactionId: txn.id,
        paymentId: payment._id,
        status: payment.status,
      });
    }

    return {
      provider,
      timestamp: new Date(),
      summary: {
        matched: results.matched.length,
        unmatched: results.unmatched.length,
        discrepancies: results.discrepancies.length,
      },
      results,
    };
  }

  async getReconciliationReport(period = 'day') {
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const ledger = await paymentLedgerService.getPaymentTransitionsByPeriod({
      startDate,
      limit: 10000,
    });

    const reconciled = ledger.filter(e => e.transactionId);
    const unreconciled = ledger.filter(e => !e.transactionId);

    return {
      period,
      startDate,
      endDate: new Date(),
      totalEntries: ledger.length,
      reconciled: reconciled.length,
      unreconciled: unreconciled.length,
      reconciledPercentage: ((reconciled.length / ledger.length) * 100).toFixed(2),
    };
  }

  async flagDiscrepancy(paymentId, reason) {
    const payment = await paymentRepository.findById(paymentId);
    if (!payment) {
      throw new ApiError('Payment not found', 404);
    }

    return {
      paymentId,
      flagged: true,
      reason,
      flaggedAt: new Date(),
      status: 'UNDER_REVIEW',
    };
  }

  async resolveDiscrepancy(paymentId, action) {
    const validActions = ['APPROVE', 'ADJUST', 'REFUND', 'INVESTIGATE'];
    if (!validActions.includes(action)) {
      throw new ApiError('Invalid action', 400);
    }

    return {
      paymentId,
      action,
      resolvedAt: new Date(),
      status: 'RESOLVED',
    };
  }
}

module.exports = new PaymentReconciliationService();
