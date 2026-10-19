/**
 * PAYMENT LEDGER SERVICE
 * Immutable audit trail of all payment state changes
 * Critical for reconciliation and compliance
 * 
 * Reuses patterns from:
 * - allocation.service.js (session support)
 * - inventory.service.js (immutable log design)
 * - payments.service.js (payment workflow)
 */

const mongoose = require('mongoose');
const paymentLedgerRepository = require('../repositories/paymentLedger.repository');
const paymentRepository = require('../repositories/payments.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class PaymentLedgerService {
  /**
   * Log payment change (APPEND-ONLY, immutable)
   * Called whenever payment status changes
   * 
   * @param {string} paymentId
   * @param {string} oldStatus - Previous status
   * @param {string} newStatus - New status
   * @param {Object} context - { userId, reason, transactionId, providerResponse }
   * @returns {Promise<Object>}
   */
  async logPaymentChange(paymentId, oldStatus, newStatus, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Get payment to verify it exists and has orderId
      const payment = await paymentRepository.findById(paymentId);
      if (!payment) {
        await session.abortTransaction();
        throw new ApiError('Payment not found', 404);
      }

      // Create immutable ledger entry
      const ledgerEntry = await paymentLedgerRepository.create(
        {
          paymentId: String(paymentId),
          orderId: payment.orderId ? String(payment.orderId) : null,
          userId: payment.userId ? String(payment.userId) : null,
          sellerId: payment.sellerId ? String(payment.sellerId) : null,
          
          // Status transition
          oldStatus: oldStatus || 'UNKNOWN',
          newStatus,
          amount: payment.amount,
          currency: payment.currency || 'ETB',
          
          // Context
          actor: context.userId ? String(context.userId) : 'SYSTEM',
          actorType: context.actorType || 'SYSTEM', // 'SYSTEM', 'ADMIN', 'USER'
          reason: context.reason || '',
          transactionId: context.transactionId || null,
          providerResponse: context.providerResponse || null,
          
          // Timestamp (immutable)
          timestamp: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return ledgerEntry;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get payment history (full change log)
   * @param {string} paymentId
   * @param {Object} options - { limit, offset }
   * @returns {Promise<Array>}
   */
  async getPaymentHistory(paymentId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    return paymentLedgerRepository.find({
      filter: { paymentId: String(paymentId) },
      limit,
      offset,
      sort: { timestamp: -1 },
    });
  }

  /**
   * Get all changes for order's payment
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getOrderPaymentHistory(orderId) {
    return paymentLedgerRepository.find({
      filter: { orderId: String(orderId) },
      limit: 100,
      sort: { timestamp: -1 },
    });
  }

  /**
   * Audit payment integrity - verify no tampering
   * @param {string} paymentId
   * @returns {Promise<Object>}
   */
  async auditPayment(paymentId) {
    const payment = await paymentRepository.findById(paymentId);
    if (!payment) {
      throw new ApiError('Payment not found', 404);
    }

    const ledger = await this.getPaymentHistory(paymentId, { limit: 1000 });

    // Verify ledger exists and has entries
    if (!ledger || ledger.length === 0) {
      return {
        paymentId,
        status: 'NO_LEDGER_ENTRIES',
        verified: false,
        issues: ['No ledger entries found for payment'],
      };
    }

    // Verify current payment status matches latest ledger entry
    const latestEntry = ledger[0];
    const statusMatches = payment.status === latestEntry.newStatus;

    // Verify all amounts consistent
    const allAmountsConsistent = ledger.every(
      entry => entry.amount === payment.amount
    );

    return {
      paymentId,
      currentStatus: payment.status,
      latestLedgerStatus: latestEntry.newStatus,
      statusMatches,
      amountsConsistent: allAmountsConsistent,
      ledgerEntryCount: ledger.length,
      verified: statusMatches && allAmountsConsistent,
      issues: [
        !statusMatches ? 'Status mismatch between payment and ledger' : null,
        !allAmountsConsistent ? 'Amount variance in ledger' : null,
      ].filter(Boolean),
    };
  }

  /**
   * Get rejected/failed payments (for retry logic)
   * @param {Object} options - { limit, offset, days }
   * @returns {Promise<Array>}
   */
  async getFailedPayments(options = {}) {
    const { limit = 50, offset = 0, days = 7 } = options;
    
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    return paymentLedgerRepository.find({
      filter: {
        newStatus: 'FAILED',
        timestamp: { $gte: sinceDate },
      },
      limit,
      offset,
      sort: { timestamp: -1 },
    });
  }

  /**
   * Get payment transitions for specific period
   * @param {Object} options - { startDate, endDate, limit }
   * @returns {Promise<Array>}
   */
  async getPaymentTransitionsByPeriod(options = {}) {
    const { startDate, endDate, limit = 1000 } = options;

    const filter = {};
    if (startDate) filter.timestamp = { $gte: new Date(startDate) };
    if (endDate) {
      if (!filter.timestamp) filter.timestamp = {};
      filter.timestamp.$lte = new Date(endDate);
    }

    return paymentLedgerRepository.find({
      filter,
      limit,
      sort: { timestamp: -1 },
    });
  }

  /**
   * Get ledger statistics for period
   * @param {Object} options - { startDate, endDate }
   * @returns {Promise<Object>}
   */
  async getLedgerStats(options = {}) {
    const { startDate, endDate } = options;

    const transitions = await this.getPaymentTransitionsByPeriod({
      startDate,
      endDate,
      limit: 10000,
    });

    const stats = {
      totalTransitions: transitions.length,
      byStatus: {},
      totalAmount: 0,
      byActor: {},
    };

    transitions.forEach(t => {
      // Count by new status
      stats.byStatus[t.newStatus] = (stats.byStatus[t.newStatus] || 0) + 1;
      
      // Sum amounts
      stats.totalAmount += t.amount || 0;
      
      // Count by actor
      stats.byActor[t.actorType] = (stats.byActor[t.actorType] || 0) + 1;
    });

    return stats;
  }
}

module.exports = new PaymentLedgerService();
