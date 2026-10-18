/**
 * COMMISSION LEDGER REPOSITORY
 * Reuses pattern from paymentLedger.repository.js
 */

const CommissionLedger = require('../models/CommissionLedger');

class CommissionLedgerRepository {
  /**
   * Create ledger entry (APPEND-ONLY)
   */
  create(data, options = {}) {
    const { session } = options;
    const doc = new CommissionLedger({
      ...data,
      timestamp: data.timestamp || new Date(),
    });
    return session ? doc.save({ session }) : doc.save();
  }

  /**
   * Find ledger entries
   */
  find(query = {}, options = {}) {
    const {
      filter = {},
      limit = 50,
      offset = 0,
      sort = { timestamp: -1 },
      session,
    } = query;

    let q = CommissionLedger.find(filter);
    if (session) q = q.session(session);
    return q.sort(sort).skip(offset).limit(limit).exec();
  }

  /**
   * Count entries
   */
  countByFilter(filter = {}) {
    return CommissionLedger.countDocuments(filter);
  }

  /**
   * Get commission breakdown by rate
   */
  async getRateStats(filter = {}) {
    return CommissionLedger.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$commissionRate',
          count: { $sum: 1 },
          totalCommission: { $sum: '$platformCommission' },
          totalGross: { $sum: '$grossSubtotal' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
  }

  /**
   * Get daily totals
   */
  async getDailyTotals(filter = {}) {
    return CommissionLedger.aggregate([
      { $match: filter },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          count: { $sum: 1 },
          totalCommission: { $sum: '$platformCommission' },
          totalGross: { $sum: '$grossSubtotal' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
  }
}

module.exports = new CommissionLedgerRepository();
