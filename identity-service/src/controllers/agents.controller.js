// Agent controller — thin HTTP layer over agents.service.
const agentsService = require('../services/agents.service');
const auditService = require('../services/audit.service');
const { ok, created } = require('../utils/response');

async function createAgent(req, res, next) {
  try {
    const agent = await agentsService.createAgent({
      userId: req.body.userId || req.user.id,
      sectorId: req.body.sectorId,
      commissionRate: req.body.commissionRate,
    });
    return created(res, { agent }, 'Agent created');
  } catch (err) {
    return next(err);
  }
}

async function getAgent(req, res, next) {
  try {
    const agent = await agentsService.getAgent(req.params.id);
    return ok(res, { agent });
  } catch (err) {
    return next(err);
  }
}

async function getMyAgent(req, res, next) {
  try {
    const agent = await agentsService.getAgentByUser(req.user.id);
    return ok(res, { agent });
  } catch (err) {
    return next(err);
  }
}

async function getAgentByUser(req, res, next) {
  try {
    const agent = await agentsService.getAgentByUser(req.params.userId);
    return ok(res, { agent });
  } catch (err) {
    return next(err);
  }
}

async function listAgents(req, res, next) {
  try {
    const agents = await agentsService.listAgents();
    return ok(res, { agents });
  } catch (err) {
    return next(err);
  }
}

async function verifyAgent(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const agent = await agentsService.verifyAgent({
      agentId: req.params.id,
      verificationStatus: req.body.verificationStatus,
    });
    if (req.body.verificationStatus === 'APPROVED') {
      await auditService.logAgentVerified(adminId, adminName, req.params.id, req);
    } else if (req.body.verificationStatus === 'REJECTED') {
      await auditService.logAgentRejected(adminId, adminName, req.params.id, req.body.reason || null, req);
    }
    return ok(res, { agent }, 'Agent verification updated');
  } catch (err) {
    return next(err);
  }
}

async function updateAgent(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const previousAgent = await agentsService.getAgent(req.params.id);
    const agent = await agentsService.updateAgent({
      agentId: req.params.id,
      sectorId: req.body.sectorId,
      commissionRate: req.body.commissionRate,
      documents: req.body.documents,
      isActive: req.body.isActive,
    });
    const previousValue = { sectorId: previousAgent.sectorId, commissionRate: previousAgent.commissionRate, isActive: previousAgent.isActive };
    const newValue = { sectorId: agent.sectorId, commissionRate: agent.commissionRate, isActive: agent.isActive };
    await auditService.logAgentUpdated(adminId, adminName, req.params.id, previousValue, newValue, req);
    return ok(res, { agent }, 'Agent updated');
  } catch (err) {
    return next(err);
  }
}

async function setCommissionRate(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const previousAgent = await agentsService.getAgent(req.params.id);
    const agent = await agentsService.setCommissionRate({
      agentId: req.params.id,
      commissionRate: req.body.commissionRate,
    });
    await auditService.logAgentCommissionChanged(adminId, adminName, req.params.id, previousAgent.commissionRate, req.body.commissionRate, req);
    return ok(res, { agent }, 'Commission rate updated');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createAgent,
  getAgent,
  getMyAgent,
  getAgentByUser,
  listAgents,
  verifyAgent,
  updateAgent,
  setCommissionRate,
};