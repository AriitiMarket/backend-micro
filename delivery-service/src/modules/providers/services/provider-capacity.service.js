const providersRepo = require('../repositories/providers.repository');
const auditClient = require('../../../shared/utils/audit-client');

async function incrementWorkload(providerId, workloadId, actor = null) {
  const result = await providersRepo.incrementWorkload(providerId, workloadId);
  if (!result) {
    const p = await providersRepo.findById(providerId);
    if (!p) throw Object.assign(new Error('Provider not found'), { status: 404 });
    if (p.currentWorkloadIds && p.currentWorkloadIds.includes(String(workloadId))) {
      return p; // Idempotent success
    }
    throw Object.assign(new Error(`Provider capacity exceeded. Max: ${p.maxActiveAssignments}, Active: ${p.activeDeliveries}`), { status: 409 });
  }

  // Auto transition to busy if maxed out (missing field falls back to the schema default)
  const maxAssignments = Number.isFinite(result.maxActiveAssignments) ? result.maxActiveAssignments : 3;
  if (result.activeDeliveries >= maxAssignments && result.status === 'available') {
    await providersRepo.updateFields(providerId, { status: 'busy' });
  }

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_WORKLOAD_INCREMENTED',
      targetEntity: 'provider',
      targetId: providerId,
      adminId: actor?.id,
      adminName: actor?.name,
      metadata: { workloadId, activeDeliveries: result.activeDeliveries }
    }).catch(() => null);
  }

  return result;
}

async function decrementWorkload(providerId, workloadId, actor = null) {
  let result = await providersRepo.decrementWorkload(providerId, workloadId);
  if (!result) {
    const p = await providersRepo.findById(providerId);
    if (!p) throw Object.assign(new Error('Provider not found'), { status: 404 });
    return p; // Already removed or never added - idempotent success
  }

  // Auto transition to available if they were busy and now have capacity
  const maxAssignments = Number.isFinite(result.maxActiveAssignments) ? result.maxActiveAssignments : 3;
  if (result.activeDeliveries < maxAssignments && result.status === 'busy') {
    result = await providersRepo.updateFields(providerId, { status: 'available' });
  }

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_WORKLOAD_DECREMENTED',
      targetEntity: 'provider',
      targetId: providerId,
      adminId: actor?.id,
      adminName: actor?.name,
      metadata: { workloadId, activeDeliveries: result.activeDeliveries }
    }).catch(() => null);
  }

  return result;
}

async function completeDelivery(providerId, workloadId, actor = null) {
  // Free up capacity
  await decrementWorkload(providerId, workloadId, actor);
  // Increment success metric
  return providersRepo.incrementCompletedDeliveries(providerId);
}

module.exports = {
  incrementWorkload,
  decrementWorkload,
  completeDelivery
};
