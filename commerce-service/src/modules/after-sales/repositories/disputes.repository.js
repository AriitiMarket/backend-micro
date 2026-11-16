const Dispute = require('../models/Dispute');

class DisputesRepository {
  async create(data, options = {}) {
    const { session } = options;
    const dispute = new Dispute(data);
    return session ? dispute.save({ session }) : dispute.save();
  }

  async findById(id, options = {}) {
    const { session } = options;
    let q = Dispute.findById(id);
    if (session) q = q.session(session);
    return q.exec ? q.exec() : q;
  }

  async findByOrderId(orderId) {
    return Dispute.find({ orderId });
  }

  async findByBuyerId(buyerId) {
    return Dispute.find({ buyerId });
  }

  async findBySellerId(sellerId) {
    return Dispute.find({ sellerId });
  }

  async findAll(filter = {}, options = {}) {
    const { skip = 0, limit = 50, sort = { createdAt: -1 } } = options;
    return Dispute.find(filter).skip(skip).limit(limit).sort(sort);
  }

  // Alias for OrderDisputeRepository.find({ filter })
  async find(query = {}) {
    const { filter = {} } = query;
    return Dispute.find(filter).sort({ createdAt: -1 });
  }

  async update(id, data, options = {}) {
    const { session } = options;
    let q = Dispute.findByIdAndUpdate(id, data, { new: true });
    if (session) q = q.session(session);
    return q.exec ? q.exec() : q;
  }

  async count(filter = {}) {
    return Dispute.countDocuments(filter);
  }

  async countByStatus(status) {
    return Dispute.countDocuments({ status });
  }

  async updateById(id, data, options = {}) {
    return this.update(id, data, options);
  }

  async updateStatus(id, status) {
    const update = { status };
    if (String(status).toLowerCase() === 'resolved') {
      update.resolvedAt = new Date();
    } else if (String(status).toLowerCase() === 'closed') {
      update.closedAt = new Date();
    }
    return Dispute.findByIdAndUpdate(id, update, { new: true });
  }

  async addNote(disputeId, note) {
    return Dispute.findByIdAndUpdate(
      disputeId,
      { $push: { notes: note } },
      { new: true }
    );
  }

  async addTimelineEvent(disputeId, event) {
    return Dispute.findByIdAndUpdate(
      disputeId,
      { $push: { timeline: event } },
      { new: true }
    );
  }

  async addEvidence(disputeId, evidence) {
    return Dispute.findByIdAndUpdate(
      disputeId,
      { $push: { evidence } },
      { new: true }
    );
  }

  async assignToAdmin(id, adminId, adminName) {
    return Dispute.findByIdAndUpdate(
      id,
      { assignedToAdmin: adminId },
      { new: true }
    );
  }

  async updatePriority(id, priority) {
    return Dispute.findByIdAndUpdate(
      id,
      { priority },
      { new: true }
    );
  }

  async getStats() {
    const [total, open, inProgress, underInvestigation, resolved, rejected, closed, high, critical] = await Promise.all([
      Dispute.countDocuments({}),
      Dispute.countDocuments({ status: { $in: ['open', 'OPEN'] } }),
      Dispute.countDocuments({ status: { $in: ['in_progress', 'INVESTIGATING'] } }),
      Dispute.countDocuments({ status: { $in: ['under_investigation', 'ESCALATED'] } }),
      Dispute.countDocuments({ status: { $in: ['resolved', 'RESOLVED'] } }),
      Dispute.countDocuments({ status: 'rejected' }),
      Dispute.countDocuments({ status: 'closed' }),
      Dispute.countDocuments({ priority: { $in: ['high', 'HIGH'] } }),
      Dispute.countDocuments({ priority: { $in: ['critical', 'CRITICAL'] } }),
    ]);

    return {
      totalDisputes: total,
      pendingReview: open,
      openActive: inProgress + underInvestigation,
      underInvestigation,
      resolvedDisputes: resolved,
      rejectedClosed: rejected + closed,
      highPriority: high,
      criticalPriority: critical,
    };
  }

  async getRecentDisputes(limit = 10) {
    return Dispute.find({})
      .sort({ createdAt: -1 })
      .limit(limit);
  }
}

module.exports = new DisputesRepository();
