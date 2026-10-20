const PayoutRequest = require('../models/PayoutRequest');

class PayoutRepository {
  /**
   * Create payout request
   */
  async create(data) {
    return PayoutRequest.create(data);
  }

  /**
   * Get payout request by ID
   */
  async findById(id) {
    return PayoutRequest.findById(id).lean();
  }

  /**
   * Get by seller ID with pagination
   */
  async findBySellerId(sellerId, options = {}) {
    const { limit = 50, offset = 0, status } = options;

    const filter = { sellerId };
    if (status) filter.status = status;

    return PayoutRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  /**
   * Get count for pagination
   */
  async countBySellerId(sellerId, status) {
    const filter = { sellerId };
    if (status) filter.status = status;
    return PayoutRequest.countDocuments(filter);
  }

  /**
   * Get pending payouts (admin view)
   */
  async findPending(options = {}) {
    const { limit = 50, offset = 0 } = options;

    return PayoutRequest.find({ status: 'PENDING' })
      .sort({ createdAt: 1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  /**
   * Get all payouts with filtering
   */
  async findAll(filters = {}, options = {}) {
    const { limit = 50, offset = 0 } = options;

    return PayoutRequest.find(filters)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  /**
   * Count all payouts
   */
  async countAll(filters = {}) {
    return PayoutRequest.countDocuments(filters);
  }

  /**
   * Update payout status
   */
  async updateStatus(id, status, updates = {}) {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status,
          ...updates,
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Approve payout request
   */
  async approve(id, approvedBy, notes = '') {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'APPROVED',
          approvedBy,
          approvedAt: new Date(),
          notes,
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Reject payout request
   */
  async reject(id, rejectionReason, rejectedBy) {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'REJECTED',
          rejectionReason,
          processedBy: rejectedBy,
          processedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Complete payout
   */
  async complete(id, transactionId, providerResponse, processedBy) {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'COMPLETED',
          transactionId,
          providerResponse,
          processedBy,
          processedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Mark payout as failed
   */
  async fail(id, failureReason, transactionId, providerResponse) {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'FAILED',
          notes: failureReason,
          transactionId,
          providerResponse,
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Mark payout as retry — reset to PENDING with retry tracking
   */
  async retry(id, retryCount, nextRetryAt, processedBy) {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'PENDING',
          retryCount,
          nextRetryAt,
          processedBy,
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Cancel payout request
   */
  async cancel(id, cancellationReason, cancelledBy) {
    return PayoutRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'CANCELLED',
          cancellationReason,
          processedBy: cancelledBy,
          processedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { new: true }
    ).lean();
  }

  /**
   * Get payout statistics
   */
  async getStatistics(sellerId) {
    const stats = await PayoutRequest.aggregate([
      { $match: { sellerId } },
      {
        $group: {
          _id: null,
          totalRequested: { $sum: '$amount' },
          totalCompleted: {
            $sum: {
              $cond: [{ $eq: ['$status', 'COMPLETED'] }, '$amount', 0]
            }
          },
          totalFailed: {
            $sum: {
              $cond: [{ $eq: ['$status', 'FAILED'] }, '$amount', 0]
            }
          },
          totalPending: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PENDING'] }, '$amount', 0]
            }
          },
          completedCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0]
            }
          },
          failedCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0]
            }
          },
          pendingCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0]
            }
          }
        }
      }
    ]);

    return stats.length > 0 ? stats[0] : {
      totalRequested: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalPending: 0,
      completedCount: 0,
      failedCount: 0,
      pendingCount: 0
    };
  }

  /**
   * Get platform payout statistics
   */
  async getPlatformStatistics() {
    const stats = await PayoutRequest.aggregate([
      {
        $group: {
          _id: null,
          totalRequested: { $sum: '$amount' },
          totalCompleted: {
            $sum: {
              $cond: [{ $eq: ['$status', 'COMPLETED'] }, '$amount', 0]
            }
          },
          totalFailed: {
            $sum: {
              $cond: [{ $eq: ['$status', 'FAILED'] }, '$amount', 0]
            }
          },
          totalPending: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PENDING'] }, '$amount', 0]
            }
          },
          totalProcessingFees: { $sum: '$processingFee' },
          completedCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0]
            }
          },
          failedCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0]
            }
          },
          pendingCount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0]
            }
          }
        }
      }
    ]);

    return stats.length > 0 ? stats[0] : {
      totalRequested: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalPending: 0,
      totalProcessingFees: 0,
      completedCount: 0,
      failedCount: 0,
      pendingCount: 0
    };
  }
}

module.exports = new PayoutRepository();
