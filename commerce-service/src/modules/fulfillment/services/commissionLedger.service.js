/**
 * COMMISSION LEDGER SERVICE
 * Immutable audit trail of commission calculations
 * Reuses patterns from paymentLedger.service.js and inventory.service.js
 */

const mongoose = require('mongoose');
const commissionLedgerRepository = require('../repositories/commissionLedger.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class CommissionLedgerService {
  /**
   * Log commission calculation (APPEND-ONLY)
   * Called when order is confirmed and allocation computed
   * 
   * @param {string} orderId
   * @param {string} sellerId
   * @param {Object} commissionData
   * @returns {Promise<Object>}
   */
  async logCommission(orderId, sellerId, commissionData = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // commissionData structure:
      // {
      //   grossSubtotal, shippingFee, commissionRate, platformCommission,
      //   netPayable, allocationId, reason, metadata
      // }

      const ledgerEntry = await commissionLedgerRepository.create(
        {
          orderId: String(orderId),
          sellerId: String(sellerId),
          
          // Calculation breakdown
          grossSubtotal: commissionData.grossSubtotal || 0,
          shippingFee: commissionData.shippingFee || 0,
          taxAmount: commissionData.taxAmount || 0,
          discountAmount: commissionData.discountAmount || 0,
          
          // Commission
          commissionRate: commissionData.commissionRate || 0,
          platformCommission: commissionData.platformCommission || 0,
          
          // Result
          netPayable: commissionData.netPayable || 0,
          
          // Reference
          allocationId: commissionData.allocationId || null,
          
          // Metadata
          reason: commissionData.reason || 'ORDER_CONFIRMED',
          metadata: commissionData.metadata || {},
          
          // Timestamp
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
   * Get commission history for seller
   * @param {string} sellerId
   * @param {Object} options - { startDate, endDate, limit, offset }
   * @returns {Promise<Array>}
   */
  async getCommissionHistory(sellerId, options = {}) {
    const { startDate, endDate, limit = 50, offset = 0 } = options;

    const filter = { sellerId: String(sellerId) };
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate);
      if (endDate) filter.timestamp.$lte = new Date(endDate);
    }

    return commissionLedgerRepository.find({
      filter,
      limit,
      offset,
      sort: { timestamp: -1 },
    });
  }

  /**
   * Calculate total commission for period
   * @param {string} sellerId
   * @param {Object} options - { startDate, endDate }
   * @returns {Promise<Object>}
   */
  async getTotalCommissionForPeriod(sellerId, options = {}) {
    const { startDate, endDate } = options;

    const filter = { sellerId: String(sellerId) };
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate);
      if (endDate) filter.timestamp.$lte = new Date(endDate);
    }

    const entries = await commissionLedgerRepository.find({
      filter,
      limit: 10000,
      sort: { timestamp: -1 },
    });

    if (!entries || entries.length === 0) {
      return {
        sellerId,
        period: { startDate, endDate },
        totalCommission: 0,
        totalGrossRevenue: 0,
        totalNetPayable: 0,
        orderCount: 0,
        averageCommissionRate: 0,
      };
    }

    const totalCommission = entries.reduce((sum, e) => sum + (e.platformCommission || 0), 0);
    const totalGross = entries.reduce((sum, e) => sum + (e.grossSubtotal || 0), 0);
    const totalNet = entries.reduce((sum, e) => sum + (e.netPayable || 0), 0);
    const avgRate = totalGross > 0 ? (totalCommission / totalGross) * 100 : 0;

    return {
      sellerId,
      period: { startDate, endDate },
      totalCommission,
      totalGrossRevenue: totalGross,
      totalNetPayable: totalNet,
      orderCount: entries.length,
      averageCommissionRate: Math.round(avgRate * 100) / 100,
      breakdown: entries.map(e => ({
        orderId: e.orderId,
        grossSubtotal: e.grossSubtotal,
        commission: e.platformCommission,
        netPayable: e.netPayable,
        timestamp: e.timestamp,
      })),
    };
  }

  /**
   * Audit commission integrity
   * Verify calculations match with allocations
   * 
   * @param {string} sellerId
   * @param {Object} options - { startDate, endDate }
   * @returns {Promise<Object>}
   */
  async auditCommissions(sellerId, options = {}) {
    const { startDate, endDate } = options;

    const ledgerEntries = await this.getCommissionHistory(sellerId, {
      startDate,
      endDate,
      limit: 10000,
    });

    // Get corresponding allocations to verify
    const allocations = await allocationRepository.find({
      filter: { sellerId: String(sellerId) },
    });

    if (!ledgerEntries || ledgerEntries.length === 0) {
      return {
        sellerId,
        ledgerEntryCount: 0,
        allocationCount: allocations.length,
        verified: false,
        issues: ['No ledger entries found'],
      };
    }

    // Verify ledger entries match allocations count
    const ledgerOrderIds = new Set(ledgerEntries.map(l => String(l.orderId)));
    const allocationOrderIds = new Set(allocations.map(a => String(a.orderId)));

    const missingFromLedger = [...allocationOrderIds].filter(
      id => !ledgerOrderIds.has(id)
    );

    const issues = [];
    if (missingFromLedger.length > 0) {
      issues.push(`${missingFromLedger.length} allocations missing from ledger`);
    }

    return {
      sellerId,
      period: { startDate, endDate },
      ledgerEntryCount: ledgerEntries.length,
      allocationCount: allocations.length,
      verified: issues.length === 0,
      issues,
      stats: await this.getTotalCommissionForPeriod(sellerId, { startDate, endDate }),
    };
  }

  /**
   * Get commission stats by reason (for analysis)
   * @param {string} sellerId
   * @returns {Promise<Object>}
   */
  async getCommissionByReason(sellerId) {
    const entries = await this.getCommissionHistory(sellerId, { limit: 10000 });

    const byReason = {};
    entries.forEach(e => {
      const reason = e.reason || 'UNKNOWN';
      if (!byReason[reason]) {
        byReason[reason] = { count: 0, totalCommission: 0 };
      }
      byReason[reason].count += 1;
      byReason[reason].totalCommission += e.platformCommission || 0;
    });

    return byReason;
  }
}

module.exports = new CommissionLedgerService();
