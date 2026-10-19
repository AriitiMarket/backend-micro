/**
 * Inventory Ledger Repository
 * Handles CRUD operations for inventory movements (immutable audit trail)
 */

const mongoose = require('mongoose');

class InventoryLedgerRepository {
  constructor(ledgerModel) {
    this.model = ledgerModel;
  }

  /**
   * Create ledger entry (APPEND-ONLY)
   * Immutable by design - no updates or deletes
   */
  async create(data, options = {}) {
    const { session } = options;
    const doc = new this.model({
      ...data,
      timestamp: data.timestamp || new Date(),
    });
    if (session) {
      await doc.save({ session });
    } else {
      await doc.save();
    }
    return doc;
  }

  /**
   * Get ledger entries (READ-ONLY)
   */
  async find(query = {}, options = {}) {
    const {
      filter = {},
      limit = 50,
      offset = 0,
      sort = { timestamp: -1 },
      session,
    } = query;

    let q = this.model.find(filter);
    if (session) {
      q = q.session(session);
    }
    return q.sort(sort).skip(offset).limit(limit).exec();
  }

  /**
   * Get ledger entries by product
   */
  async findByProductId(productId, options = {}) {
    const {
      limit = 100,
      offset = 0,
      startDate,
      endDate,
      session,
    } = options;

    const filter = { productId };
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = startDate;
      if (endDate) filter.timestamp.$lte = endDate;
    }

    let q = this.model.find(filter);
    if (session) {
      q = q.session(session);
    }
    return q.sort({ timestamp: -1 }).skip(offset).limit(limit).exec();
  }

  /**
   * Count ledger entries
   */
  async countByFilter(filter = {}, options = {}) {
    const { session } = options;
    let query = this.model.countDocuments(filter);
    if (session) {
      query = query.session(session);
    }
    return query.exec();
  }

  /**
   * Get ledger summary stats
   */
  async getStats(productId, options = {}) {
    const { startDate, endDate, session } = options;

    const pipeline = [
      {
        $match: {
          productId: mongoose.Types.ObjectId.isValid(productId)
            ? mongoose.Types.ObjectId(productId)
            : productId,
          ...(startDate || endDate ? {
            timestamp: {
              ...(startDate && { $gte: startDate }),
              ...(endDate && { $lte: endDate }),
            },
          } : {}),
        },
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
        },
      },
      { $sort: { type: 1 } },
    ];

    let agg = this.model.aggregate(pipeline);
    if (session) {
      agg = agg.session(session);
    }
    return agg.exec();
  }

  /**
   * Verify ledger integrity (audit)
   */
  async verify(productId, expectedStock, options = {}) {
    const stats = await this.getStats(productId, options);
    
    let calculatedStock = 0;
    stats.forEach(stat => {
      if (stat._id === 'RESTOCK') calculatedStock += stat.totalQuantity;
      if (stat._id === 'ADJUST') calculatedStock += stat.totalQuantity; // Can be negative
      if (stat._id === 'ORDER_DEDUCT') calculatedStock -= stat.totalQuantity;
      if (stat._id === 'RETURN_RESTORE') calculatedStock += stat.totalQuantity;
    });

    return {
      productId,
      expectedStock,
      calculatedStock,
      verified: expectedStock === calculatedStock,
      discrepancy: expectedStock - calculatedStock,
      stats,
    };
  }
}

module.exports = InventoryLedgerRepository;
