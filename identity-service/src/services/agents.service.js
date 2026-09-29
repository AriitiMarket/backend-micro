// Agent business logic.
const usersRepository = require('../repositories/users.repository');
const agentsRepository = require('../repositories/agents.repository');

async function createAgent(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  const existing = await agentsRepository.findByUserId(payload.userId);
  if (existing) {
    const err = new Error('Agent record already exists for this user');
    err.statusCode = 409;
    throw err;
  }
  return agentsRepository.create({
    userId: payload.userId,
    sectorId: payload.sectorId || null,
    commissionRate: payload.commissionRate,
  });
}

async function getAgent(id) {
  const agent = await agentsRepository.findById(id);
  if (!agent) {
    const err = new Error('Agent not found');
    err.statusCode = 404;
    throw err;
  }
  return agent;
}

async function getAgentByUser(userId) {
  const agent = await agentsRepository.findByUserId(userId);
  if (!agent) {
    const err = new Error('Agent not found for this user');
    err.statusCode = 404;
    throw err;
  }
  return agent;
}

async function listAgents() {
  return agentsRepository.findAll();
}

async function verifyAgent(payload) {
  const agent = await getAgent(payload.agentId);
  const status = payload.verificationStatus || agent.verificationStatus;
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    const err = new Error('Invalid verification status');
    err.statusCode = 400;
    throw err;
  }
  // A verified agent becomes active by default in the verification workflow.
  return agentsRepository.updateFields({
    id: agent.id,
    fields: {
      verification_status: status,
      is_active: status === 'APPROVED',
    },
  });
}

async function updateAgent(payload) {
  const agent = await getAgent(payload.agentId);
  const fields = {};
  if (payload.sectorId !== undefined) fields.sector_id = payload.sectorId;
  if (payload.commissionRate !== undefined) fields.commission_rate = payload.commissionRate;
  if (payload.documents !== undefined) fields.documents = JSON.stringify(payload.documents);
  if (payload.isActive !== undefined) fields.is_active = payload.isActive;
  if (Object.keys(fields).length < 1) return agent;
  return agentsRepository.updateFields({ id: agent.id, fields });
}

async function setCommissionRate(payload) {
  const rate = payload.commissionRate;
  if (rate === undefined || rate < 0 || rate > 100) {
    const err = new Error('Commission rate must be between 0 and 100');
    err.statusCode = 400;
    throw err;
  }
  return agentsRepository.updateFields({
    id: payload.agentId,
    fields: { commission_rate: rate },
  });
}

module.exports = {
  createAgent,
  getAgent,
  getAgentByUser,
  listAgents,
  verifyAgent,
  updateAgent,
  setCommissionRate,
};