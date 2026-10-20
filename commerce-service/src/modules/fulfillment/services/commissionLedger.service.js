/**
 * COMMISSION LEDGER SERVICE
 * Immutable audit trail of commission calculations
 * Reuses patterns from paymentLedger.service.js and inventory.service.js
 */

const mongoose = require('mongoose');
const commissionLedgerRepository = require('../repositories/commissionLedger.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');
const settingsService = require('../../platform/services/settings.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class CommissionLedgerService {
  /**
   * Resolve the effective commission rate for an order.
   * Priority: seller variation > category commission > platform default.
   * All rates come from platform settings — callers cannot override.
   */
  async resolveCommissionRate(orderContext = {}) {
    const settings = await settingsService.getPlatformSettings();
    const { sellerId, categoryId } = orderContext;

    let rate = settings.commissionRate !== null && settings.commissionRate !== undefined && Number.isFinite(Number(settings.commissionRate))
      ? Number(settings.commissionRate) : 10;

    // Resolve in priority order. A seller-specific rate must win even when
    // the product also has a category rate.
    let sellerRate = null;
    if (sellerId && Array.isArray(settings.sellerCommissionVariations)) {
      const variation = settings.sellerCommissionVariations.find(
        (v) => v.sellerId && String(v.sellerId) === String(sellerId)
      ) || settings.sellerCommissionVariations.find(
        (v) => !v.sellerId && v.sellerType && v.sellerType === orderContext.sellerType
      );
      if (variation && typeof variation.commission === 'number') {
        sellerRate = variation.commission;
      }
    }

    let categoryRate = null;
    if ((categoryId || orderContext.categoryName) && Array.isArray(settings.categoryCommissions)) {
      const catComm = settings.categoryCommissions.find(
        (c) => (c.categoryId && String(c.categoryId) === String(categoryId)) ||
          (c.category && c.category === orderContext.categoryName)
      );
      if (catComm && typeof catComm.commission === 'number') {
        categoryRate = catComm.commission;
      }
    }

    if (sellerRate === null && sellerId && settings.sellerCommissionRates?.[sellerId] !== undefined) {
      const legacySellerRate = Number(settings.sellerCommissionRates[sellerId]);
      if (Number.isFinite(legacySellerRate)) sellerRate = legacySellerRate;
    }
    if (sellerRate !== null) rate = sellerRate;
    else if (categoryRate !== null) rate = categoryRate;
    return Math.min(Math.max(rate, 0), 100);
  }

  /**
   * Log commission calculation (APPEND-ONLY)
   * Called when order is confirmed and allocation computed
   * Commission rate is enforced from platform settings — not caller-trusted.
   *
   * @param {string} orderId
   * @param {string} sellerId
   * @param {Object} commissionData
   * @param {Object} context - { actorId, actorRole, orderContext }
   * @returns {Promise<Object>}
   */
  async logCommission(orderId, sellerId, commissionData = {}, context = {}) {
    // NOTE: this append is a SINGLE document insert, which MongoDB already
    // performs atomically, so it is deliberately NOT wrapped in a transaction.
    //
    // The transaction used to be opened here, which required a replica-set
    // member or mongos. The platform deploys a STANDALONE mongod
    // (see backend-services/docker-compose.yml: `image: mongo:7` with no
    // --replSet), so every call failed with "Transaction numbers are only
    // allowed on a replica set member or mongos" and the commission ledger —
    // the audit trail of every commission calculation — never recorded a
    // single row. The ledger's append-only guarantee comes from the model's
    // immutability hooks, not from the transaction, and no multi-document
    // invariant is involved.
    try {
      const orderContext = context.orderContext || {};
      orderContext.sellerId = sellerId;

      const commissionRate = await this.resolveCommissionRate(orderContext);

      const grossSubtotal = Number(commissionData.grossSubtotal || 0);
      const shippingFee = Number(commissionData.shippingFee || 0);
      const taxAmount = Number(commissionData.taxAmount || 0);
      const discountAmount = Number(commissionData.discountAmount || 0);
      // Commission applies to discounted merchandise only. Shipping and tax
      // are passed through and are not part of the commission base.
      const commissionBase = Math.max(0, grossSubtotal - discountAmount);
      // Recompute amounts on the server. Caller-supplied commission amounts
      // are not authoritative, and shipping/tax are outside the commission base.
      const platformCommission = Math.round((commissionBase * commissionRate) / 100 * 100) / 100;
      const netPayable = Math.round((grossSubtotal + shippingFee + taxAmount - discountAmount - platformCommission) * 100) / 100;

      const ledgerEntry = await commissionLedgerRepository.create(
        {
          orderId: String(orderId),
          sellerId: String(sellerId),

          // Calculation breakdown
          grossSubtotal,
          shippingFee,
          taxAmount,
          discountAmount,

          // Commission (enforced from platform settings)
          commissionRate,
          platformCommission,

          // Result
          netPayable,

          // Reference
          allocationId: commissionData.allocationId || null,

          // Audit metadata
          reason: commissionData.reason || 'ORDER_CONFIRMED',
          metadata: commissionData.metadata || {},
          commissionRateApplied: commissionRate,
          effectiveFrom: new Date(),

          // Actor audit trail
          actorId: context.actorId || null,
          actorRole: context.actorRole || 'SYSTEM',

          // Timestamp (immutable)
          timestamp: new Date(),
        },
      );

      return ledgerEntry;
    } catch (err) {
      throw err;
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

  /**
   * Audit commission integrity — verify platformCommission matches expected
   * calculation based on the rate in force at effectiveFrom.
   */
  async auditCommissionDrift(sellerId, options = {}) {
    const { startDate, endDate } = options;
    const entries = await this.getCommissionHistory(sellerId, {
      startDate,
      endDate,
      limit: 10000,
    });

    if (!entries || entries.length === 0) {
      return {
        sellerId,
        entryCount: 0,
        driftCount: 0,
        verified: true,
        issues: [],
      };
    }

    const issues = [];
    let driftCount = 0;

    for (const entry of entries) {
      const commissionBase = Math.max(0, Number(entry.grossSubtotal || 0) - Number(entry.discountAmount || 0));
      const expectedCommission = Math.round((commissionBase * Number(entry.commissionRateApplied || 0)) / 100 * 100) / 100;
      const actualCommission = Number(entry.platformCommission || 0);

      if (Math.abs(expectedCommission - actualCommission) > 0.01) {
        driftCount++;
        issues.push({
          orderId: entry.orderId,
          expectedCommission,
          actualCommission,
          difference: actualCommission - expectedCommission,
          commissionRateApplied: entry.commissionRateApplied,
        });
      }
    }

    return {
      sellerId,
      entryCount: entries.length,
      driftCount,
      verified: driftCount === 0,
      issues,
    };
  }
}

module.exports = new CommissionLedgerService();
