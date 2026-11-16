const mongoose = require('mongoose');
const disputesRepo = require('../repositories/disputes.repository');
const ordersRepo = require('../../orders/repositories/orders.repository');
const { sendAudit, ACTIONS, LEVELS } = require('../../../shared/utils/audit-client');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class DisputesService {
  /**
   * Unified createDispute supporting both object and positional argument signatures.
   */
  async createDispute(orderIdOrData, reason, evidence = {}, context = {}) {
    let data;
    let isPositional = false;

    if (typeof orderIdOrData === 'object' && orderIdOrData !== null) {
      data = { ...orderIdOrData };
    } else {
      isPositional = true;
      const orderId = orderIdOrData;
      data = {
        orderId: String(orderId),
        reason,
        subject: reason,
        description: reason,
        disputeType: 'ORDER',
        type: 'order',
        evidence,
        requesterId: context.userId || context.id,
        requesterRole: context.role || 'BUYER',
        status: 'OPEN',
      };
    }

    if (!data.orderId || (!data.subject && !data.reason) || (!data.description && !data.reason)) {
      throw Object.assign(
        new ApiError('Missing required fields: orderId, subject, type', 400),
        { status: 400 }
      );
    }

    const order = await ordersRepo.findById(data.orderId);
    if (!order) {
      throw Object.assign(new ApiError('Order not found', 404), { status: 404 });
    }

    const buyerId = String(order.buyerId || '');
    const sellerIds = [...new Set([
      order.sellerId,
      ...(order.sellerShipments || []).map((shipment) => shipment.sellerId),
    ].filter(Boolean).map(String))];

    const role = String(data.requesterRole || '').toUpperCase();
    if (role === 'BUYER' && buyerId && buyerId !== String(data.requesterId)) {
      throw Object.assign(new ApiError('Only the order buyer can file this dispute', 403), { status: 403 });
    }
    if (role === 'SELLER' && sellerIds.length > 0 && !sellerIds.includes(String(data.requesterId))) {
      throw Object.assign(new ApiError('Only a seller on the order can file this dispute', 403), { status: 403 });
    }

    const sellerId = role === 'SELLER'
      ? String(data.requesterId)
      : (data.sellerId && sellerIds.includes(String(data.sellerId)) ? String(data.sellerId) : sellerIds[0] || null);

    const disputeRecord = {
      ...data,
      buyerId: buyerId || data.buyerId || (role === 'BUYER' ? String(data.requesterId) : null),
      sellerId: sellerId || data.sellerId || null,
      initiator: String(data.requesterId || data.initiator || ''),
      initiatorRole: role,
      filedBy: String(data.requesterId || ''),
      filedByRole: role,
      disputeType: data.disputeType || (data.type ? String(data.type).toUpperCase() : 'ORDER'),
      type: data.type || (data.disputeType ? String(data.disputeType).toLowerCase() : 'order'),
      status: data.status || 'open',
    };

    return disputesRepo.create(disputeRecord);
  }

  /**
   * Unified updateDispute (from OrderDisputeService)
   */
  async updateDispute(disputeId, status, resolution = {}, context = {}) {
    const dispute = await disputesRepo.findById(disputeId);
    if (!dispute) {
      throw Object.assign(new ApiError('Dispute not found', 404), { status: 404 });
    }

    const validStatuses = [
      'OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED',
      'open', 'in_progress', 'under_investigation', 'resolved', 'rejected', 'closed',
    ];
    if (!validStatuses.includes(status)) {
      throw Object.assign(new ApiError('Invalid status', 400), { status: 400 });
    }

    const isResolved = status === 'RESOLVED' || status === 'resolved';
    return disputesRepo.update(disputeId, {
      status,
      resolution,
      resolvedBy: context.userId,
      resolvedAt: isResolved ? new Date() : null,
      updatedAt: new Date(),
    });
  }

  async getDispute(id) {
    const dispute = await disputesRepo.findById(id);
    if (!dispute) {
      throw Object.assign(new ApiError('Dispute not found', 404), { status: 404 });
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

  async getSellerDisputes(sellerId, status) {
    const filter = {};
    if (sellerId) {
      filter.$or = [{ sellerId: String(sellerId) }, { initiator: String(sellerId) }];
    }
    if (status) filter.status = status;
    const disputes = await disputesRepo.find({ filter });
    return disputes || [];
  }

  async getOpenDisputes() {
    return disputesRepo.find({
      filter: { status: { $nin: ['RESOLVED', 'resolved', 'CLOSED', 'closed'] } },
    });
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
      level: status === 'resolved' || status === 'RESOLVED' ? LEVELS.INFO : LEVELS.WARNING,
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

    await disputesRepo.addTimelineEvent(id, {
      action: `Priority changed from ${oldPriority} to ${priority}`,
      adminId,
      details: `Changed by admin ${adminName || 'Unknown'}`,
    });

    return updated;
  }

  async addNote(id, note, adminId, adminName) {
    await this.getDispute(id);
    return disputesRepo.addNote(id, {
      adminId,
      adminName,
      note,
      createdAt: new Date(),
    });
  }

  async addEvidence(id, evidence, adminId = null) {
    await this.getDispute(id);
    const updatedDispute = await disputesRepo.addEvidence(id, {
      ...evidence,
      uploadedAt: new Date(),
    });

    await disputesRepo.addTimelineEvent(id, {
      action: 'Evidence added',
      adminId,
      details: `Evidence: ${evidence.title || 'Untitled'}`,
    });

    return updatedDispute;
  }

  async assignDispute(id, adminId, adminName) {
    await this.getDispute(id);
    const updated = await disputesRepo.assignToAdmin(id, adminId, adminName);

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
      resolvedBy: adminId,
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
    await this.getDispute(id);
    const updated = await disputesRepo.updateById(id, {
      status: 'closed',
      closedAt: new Date(),
    });

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
