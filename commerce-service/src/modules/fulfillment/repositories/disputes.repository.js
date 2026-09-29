const Dispute = require('../models/Dispute');

class DisputesRepository {
  async create(data) {
    const dispute = new Dispute(data);
    return dispute.save();
  }

  async findById(id) {
    return Dispute.findById(id);
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

  async count(filter = {}) {
    return Dispute.countDocuments(filter);
  }

  async updateById(id, data) {
    return Dispute.findByIdAndUpdate(id, data, { new: true });
  }

  async updateStatus(id, status) {
    const update = { status };
    if (status === 'resolved') {
      update.resolvedAt = new Date();
    } else if (status === 'closed') {
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
      Dispute.countDocuments({ status: 'open' }),
      Dispute.countDocuments({ status: 'in_progress' }),
      Dispute.countDocuments({ status: 'under_investigation' }),
      Dispute.countDocuments({ status: 'resolved' }),
      Dispute.countDocuments({ status: 'rejected' }),
      Dispute.countDocuments({ status: 'closed' }),
      Dispute.countDocuments({ priority: 'high' }),
      Dispute.countDocuments({ priority: 'critical' }),
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
