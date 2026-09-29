const disputesService = require('../services/disputes.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { isAdmin } = require('../../../shared/utils/roles');

async function createDispute(req, res, next) {
  try {
    const data = { ...req.body };
    // The filing party is taken from the verified caller, never from the body: a
    // buyer always files as themselves, a seller always as their own seller id
    // (the counterparty side of the dispute still comes from the body). Only an
    // admin may file on someone else's behalf.
    const role = req.user && String(req.user.role || '').toUpperCase();
    if (role === 'SELLER') {
      data.sellerId = req.user.id;
    } else if (role !== 'ADMIN') {
      data.buyerId = req.user.id;
    }
    const result = await disputesService.createDispute(data);
    return created(res, { dispute: result }, 'Dispute created');
  } catch (err) {
    return next(err);
  }
}

async function getDispute(req, res, next) {
  try {
    const result = await disputesService.getDispute(req.params.id);
    // Only the two parties to the dispute (and an admin) may read it.
    if (!isAdmin(req.user && req.user.role)) {
      const uid = String(req.user.id);
      const isParty = String(result.buyerId || '') === uid || String(result.sellerId || '') === uid;
      if (!isParty) {
        const err = new Error('Forbidden: you can only read your own disputes');
        err.statusCode = 403;
        err.code = 'RESOURCE_NOT_OWNED';
        throw err;
      }
    }
    return ok(res, { dispute: result });
  } catch (err) {
    return next(err);
  }
}

async function listDisputes(req, res, next) {
  try {
    const { status, priority, type, buyerId, sellerId, page = 1, limit = 10, sortBy = 'createdAt' } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (type) filter.type = type;
    if (buyerId) filter.buyerId = buyerId;
    if (sellerId) filter.sellerId = sellerId;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: -1 };

    const disputes = await disputesService.listDisputes(filter, {
      skip,
      limit: parseInt(limit),
      sort,
    });
    const total = await require('../repositories/disputes.repository').count(filter);

    return ok(res, { disputes, total, count: disputes.length });
  } catch (err) {
    return next(err);
  }
}

async function updateDisputeStatus(req, res, next) {
  try {
    const { status } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.name || req.headers['x-admin-name'] || 'Unknown';

    const result = await disputesService.updateDisputeStatus(
      req.params.id,
      status,
      adminId,
      adminName
    );
    sendAudit({ action: 'DISPUTE_STATUS_CHANGED', level: 'WARNING', adminId, adminName, module: 'disputes', targetEntity: 'dispute', targetId: req.params.id, newValue: { status }, ipAddress: req?.ip || null });
    return ok(res, { dispute: result }, 'Dispute status updated');
  } catch (err) {
    return next(err);
  }
}

async function updateDisputePriority(req, res, next) {
  try {
    const { priority } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.name || req.headers['x-admin-name'] || 'Unknown';

    const result = await disputesService.updateDisputePriority(
      req.params.id,
      priority,
      adminId,
      adminName
    );
    sendAudit({ action: 'DISPUTE_PRIORITY_CHANGED', level: 'INFO', adminId, adminName, module: 'disputes', targetEntity: 'dispute', targetId: req.params.id, newValue: { priority }, ipAddress: req?.ip || null });
    return ok(res, { dispute: result }, 'Dispute priority updated');
  } catch (err) {
    return next(err);
  }
}

async function addNote(req, res, next) {
  try {
    const { note } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.name || req.headers['x-admin-name'] || 'Unknown';

    const result = await disputesService.addNote(req.params.id, note, adminId, adminName);
    return ok(res, { dispute: result }, 'Note added');
  } catch (err) {
    return next(err);
  }
}

async function addEvidence(req, res, next) {
  try {
    const { title, description, fileUrl } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];

    const result = await disputesService.addEvidence(
      req.params.id,
      { title, description, fileUrl },
      adminId
    );
    return ok(res, { dispute: result }, 'Evidence added');
  } catch (err) {
    return next(err);
  }
}

async function assignDispute(req, res, next) {
  try {
    const { adminId, adminName } = req.body;
    const result = await disputesService.assignDispute(req.params.id, adminId, adminName);
    sendAudit({ action: 'DISPUTE_ASSIGNED', level: 'INFO', adminId, adminName, module: 'disputes', targetEntity: 'dispute', targetId: req.params.id, newValue: { assignedTo: adminId }, ipAddress: req?.ip || null });
    return ok(res, { dispute: result }, 'Dispute assigned');
  } catch (err) {
    return next(err);
  }
}

async function resolveDispute(req, res, next) {
  try {
    const { resolution, resolutionType, compensationAmount } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.name || req.headers['x-admin-name'] || 'Unknown';

    const result = await disputesService.resolveDispute(
      req.params.id,
      resolution,
      resolutionType,
      compensationAmount,
      adminId,
      adminName
    );
    sendAudit({ action: 'DISPUTE_RESOLVED', level: 'INFO', adminId, adminName, module: 'disputes', targetEntity: 'dispute', targetId: req.params.id, newValue: { resolution, resolutionType, compensationAmount }, ipAddress: req?.ip || null });
    return ok(res, { dispute: result }, 'Dispute resolved');
  } catch (err) {
    return next(err);
  }
}

async function rejectDispute(req, res, next) {
  try {
    const { reason } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.name || req.headers['x-admin-name'] || 'Unknown';

    const result = await disputesService.rejectDispute(req.params.id, reason, adminId, adminName);
    sendAudit({ action: 'DISPUTE_REJECTED', level: 'WARNING', adminId, adminName, module: 'disputes', targetEntity: 'dispute', targetId: req.params.id, reason, ipAddress: req?.ip || null });
    return ok(res, { dispute: result }, 'Dispute rejected');
  } catch (err) {
    return next(err);
  }
}

async function closeDispute(req, res, next) {
  try {
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.name || req.headers['x-admin-name'] || 'Unknown';

    const result = await disputesService.closeDispute(req.params.id, adminId, adminName);
    sendAudit({ action: 'DISPUTE_STATUS_CHANGED', level: 'INFO', adminId, adminName, module: 'disputes', targetEntity: 'dispute', targetId: req.params.id, newValue: { status: 'CLOSED' }, ipAddress: req?.ip || null });
    return ok(res, { dispute: result }, 'Dispute closed');
  } catch (err) {
    return next(err);
  }
}

async function getStats(req, res, next) {
  try {
    const stats = await disputesService.getStats();
    return ok(res, { stats });
  } catch (err) {
    return next(err);
  }
}

async function getRecentDisputes(req, res, next) {
  try {
    const { limit = 10 } = req.query;
    const disputes = await disputesService.getRecentDisputes(parseInt(limit));
    return ok(res, { disputes, count: disputes.length });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createDispute,
  getDispute,
  listDisputes,
  updateDisputeStatus,
  updateDisputePriority,
  addNote,
  addEvidence,
  assignDispute,
  resolveDispute,
  rejectDispute,
  closeDispute,
  getStats,
  getRecentDisputes,
};
