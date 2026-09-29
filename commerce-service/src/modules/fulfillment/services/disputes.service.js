const disputesRepo = require('../repositories/disputes.repository');
const ordersRepo = require('../repositories/orders.repository');
const { sendAudit, ACTIONS, LEVELS } = require('../../../shared/utils/audit-client');

class DisputesService {
  async createDispute(data) {
    if (!data.orderId || !data.requesterId || !data.subject || !data.description || !data.type) {
      throw Object.assign(
        new Error('Missing required fields: orderId, subject, type'),
        { status: 400 }
      );
    }
    const order = await ordersRepo.findById(data.orderId);
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    const buyerId = String(order.buyerId);
    const sellerIds = [...new Set([
      order.sellerId,
      ...(order.sellerShipments || []).map((shipment) => shipment.sellerId),
    ].filter(Boolean).map(String))];
    const role = String(data.requesterRole || '').toUpperCase();
    if (role === 'BUYER' && buyerId !== String(data.requesterId)) {
      throw Object.assign(new Error('Only the order buyer can file this dispute'), { status: 403 });
    }
    if (role === 'SELLER' && !sellerIds.includes(String(data.requesterId))) {
      throw Object.assign(new Error('Only a seller on the order can file this dispute'), { status: 403 });
    }
    const sellerId = role === 'SELLER' ? String(data.requesterId) : (data.sellerId && sellerIds.includes(String(data.sellerId)) ? String(data.sellerId) : sellerIds[0] || null);
    return disputesRepo.create({
      ...data,
      buyerId,
      sellerId,
      filedBy: String(data.requesterId),
      filedByRole: role,
    });
  }

  async getDispute(id) {
    const dispute = await disputesRepo.findById(id);
    if (!dispute) {
      throw Object.assign(new Error('Dispute not found'), { status: 404 });
    }
    return dispute;
  }

  async listDisputes(filter = {}, options = {}) {
    return disputesRepo.findAll(filter, options);
  }

  async getDisputesByStatus(status) {
    return disputesRepo.findAll({ status }, { limit: 100 });
  }

  async getDisputesByBuyer(buyerId, options = {}) {
    return disputesRepo.findAll({ buyerId }, options);
  }

  async getDisputesBySeller(sellerId, options = {}) {
    return disputesRepo.findAll({ sellerId }, options);
  }

  async getDisputesByOrder(orderId) {
    return disputesRepo.findByOrderId(orderId);
  }

  async updateDisputeStatus(id, status, adminId = null, adminName = null) {
    const dispute = await this.getDispute(id);
    const oldStatus = dispute.status;

    const updated = await disputesRepo.updateStatus(id, status);

    await disputesRepo.addTimelineEvent(id, {
      action: `Status changed from ${oldStatus} to ${status}`,
      adminId,
      details: `Changed by admin ${adminName || 'Unknown'}`,
    });

    sendAudit({
      action: ACTIONS.DISPUTE_STATUS_CHANGED,
      level: status === 'resolved' ? LEVELS.INFO : LEVELS.WARNING,
      adminId, adminName,
      module: 'disputes',
      targetEntity: 'dispute',
      targetId: id,
      previousValue: { status: oldStatus },
      newValue: { status },
    });

    return updated;
  }

  async updateDisputePriority(id, priority, adminId = null, adminName = null) {
    const dispute = await this.getDispute(id);
    const oldPriority = dispute.priority;

    const updated = await disputesRepo.updatePriority(id, priority);

    // Add timeline event
    await disputesRepo.addTimelineEvent(id, {
      action: `Priority changed from ${oldPriority} to ${priority}`,
      adminId,
      details: `Changed by admin ${adminName || 'Unknown'}`,
    });

    return updated;
  }

  async addNote(id, note, adminId, adminName) {
    const dispute = await this.getDispute(id);
    
    return disputesRepo.addNote(id, {
      adminId,
      adminName,
      note,
      createdAt: new Date(),
    });
  }

  async addEvidence(id, evidence, adminId = null) {
    const dispute = await this.getDispute(id);
    
    const updatedDispute = await disputesRepo.addEvidence(id, {
      ...evidence,
      uploadedAt: new Date(),
    });

    // Add timeline event
    await disputesRepo.addTimelineEvent(id, {
      action: 'Evidence added',
      adminId,
      details: `Evidence: ${evidence.title || 'Untitled'}`,
    });

    return updatedDispute;
  }

  async assignDispute(id, adminId, adminName) {
    const dispute = await this.getDispute(id);

    const updated = await disputesRepo.assignToAdmin(id, adminId, adminName);

    // Add timeline event
    await disputesRepo.addTimelineEvent(id, {
      action: 'Assigned to admin',
      adminId,
      details: `Assigned to ${adminName || adminId}`,
    });

    return updated;
  }

  async resolveDispute(id, resolution, resolutionType, compensationAmount, adminId, adminName) {
    const dispute = await this.getDispute(id);

    const updated = await disputesRepo.updateById(id, {
      status: 'resolved',
      resolution,
      resolutionType,
      compensationAmount: compensationAmount || 0,
      resolvedAt: new Date(),
    });

    await disputesRepo.addTimelineEvent(id, {
      action: 'Dispute resolved',
      adminId,
      details: `Resolution: ${resolution}, Type: ${resolutionType}, Amount: ${compensationAmount || 0}`,
    });

    await disputesRepo.addNote(id, {
      adminId,
      adminName,
      note: `Resolved: ${resolution}`,
      createdAt: new Date(),
    });

    sendAudit({
      action: ACTIONS.DISPUTE_RESOLVED,
      adminId, adminName,
      module: 'disputes',
      targetEntity: 'dispute',
      targetId: id,
      newValue: { status: 'resolved', resolution, resolutionType, compensationAmount },
      details: { orderId: dispute.orderId },
    });

    return updated;
  }

  async rejectDispute(id, reason, adminId, adminName) {
    const dispute = await this.getDispute(id);

    const updated = await disputesRepo.updateById(id, {
      status: 'rejected',
      closedAt: new Date(),
    });

    await disputesRepo.addTimelineEvent(id, {
      action: 'Dispute rejected',
      adminId,
      details: `Reason: ${reason}`,
    });

    await disputesRepo.addNote(id, {
      adminId,
      adminName,
      note: `Rejected: ${reason}`,
      createdAt: new Date(),
    });

    sendAudit({
      action: ACTIONS.DISPUTE_REJECTED,
      level: LEVELS.WARNING,
      adminId, adminName,
      module: 'disputes',
      targetEntity: 'dispute',
      targetId: id,
      reason,
      details: { orderId: dispute.orderId },
    });

    return updated;
  }

  async closeDispute(id, adminId, adminName) {
    const dispute = await this.getDispute(id);

    const updated = await disputesRepo.updateById(id, {
      status: 'closed',
      closedAt: new Date(),
    });

    // Add timeline event
    await disputesRepo.addTimelineEvent(id, {
      action: 'Dispute closed',
      adminId,
      details: `Closed by ${adminName || adminId}`,
    });

    return updated;
  }

  async getStats() {
    return disputesRepo.getStats();
  }

  async getRecentDisputes(limit = 10) {
    return disputesRepo.getRecentDisputes(limit);
  }
}

module.exports = new DisputesService();
