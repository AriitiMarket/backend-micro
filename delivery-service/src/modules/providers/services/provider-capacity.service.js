const providersRepo = require('../repositories/providers.repository');
const auditClient = require('../../../shared/utils/audit-client');

/** Statuses that represent an ACTIVE provider (the only ones with availability). */
const ACTIVE_STATUSES = ['available', 'busy', 'offline'];

/** Schema default when a document predates `maxActiveAssignments`. */
const maxOf = (provider) =>
  Number.isFinite(provider.maxActiveAssignments) ? provider.maxActiveAssignments : 3;

/**
 * THE availability rule, in one place: a provider's LOAD decides their shift.
 *
 *   ACTIVE + under capacity -> available   (they may receive new work)
 *   ACTIVE + at capacity     -> busy        (they may not — §19)
 *   offline                  -> unchanged   (the provider's own switch wins)
 *   pending/rejected/suspended -> unchanged (account status, not availability)
 *
 * Deriving it instead of patching it case-by-case is what makes "a provider is
 * freed automatically when a delivery succeeds" deterministic: every capacity
 * change re-derives the flag, including the idempotent re-release paths that
 * previously left a provider stuck in `busy` (and therefore ineligible)
 * forever.
 */
function availabilityForLoad(provider) {
  return (provider.activeDeliveries ?? 0) >= maxOf(provider) ? 'busy' : 'available';
}

async function syncAvailability(providerId, doc) {
  const provider = doc || (await providersRepo.findById(providerId));
  if (!provider) return null;
  // Not ACTIVE -> no availability to derive (account status owns this record).
  if (!ACTIVE_STATUSES.includes(provider.status)) return provider;
  // The provider's own Online/Offline switch is authoritative here; the value
  // is re-derived the next time they come online.
  if (provider.status === 'offline') return provider;
  const next = availabilityForLoad(provider);
  if (next === provider.status) return provider;
  return providersRepo.updateFields(providerId, { status: next });
}

async function incrementWorkload(providerId, workloadId, actor = null) {
  const result = await providersRepo.incrementWorkload(providerId, workloadId);
  if (!result) {
    const p = await providersRepo.findById(providerId);
    if (!p) throw Object.assign(new Error('Provider not found'), { status: 404 });
    if (p.currentWorkloadIds && p.currentWorkloadIds.includes(String(workloadId))) {
      return syncAvailability(providerId, p); // Idempotent success — still re-derive
    }
    throw Object.assign(new Error(`Provider capacity exceeded. Max: ${p.maxActiveAssignments}, Active: ${p.activeDeliveries}`), { status: 409 });
  }

  // At capacity they become BUSY (and stop being eligible for new work).
  const updated = await syncAvailability(providerId, result);

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

  return updated;
}

async function decrementWorkload(providerId, workloadId, actor = null) {
  const result = await providersRepo.decrementWorkload(providerId, workloadId);
  if (!result) {
    const p = await providersRepo.findById(providerId);
    if (!p) throw Object.assign(new Error('Provider not found'), { status: 404 });
    // Already released — but a repeated release must still heal the provider:
    // this is what frees a provider that was left `busy` by an earlier bug or a
    // double-closed delivery.
    return syncAvailability(providerId, p);
  }

  // Capacity freed -> AVAILABLE again, automatically, with no admin action.
  const updated = await syncAvailability(providerId, result);

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

  return updated;
}

/**
 * A SUCCEEDED delivery: free the capacity (which re-derives availability) and
 * credit the completed count.
 */
async function completeDelivery(providerId, workloadId, actor = null) {
  await decrementWorkload(providerId, workloadId, actor);
  await syncAvailability(providerId, null);
  // Increment success metric
  return providersRepo.incrementCompletedDeliveries(providerId);
}

module.exports = {
  // The availability rule is shared with the availability service so "busy"
  // means exactly one thing everywhere: ACTIVE and at capacity.
  availabilityForLoad,
  /**
   * Recompute a provider's availability from their current load without
   * touching the counters. Used when work is released without an assignment
   * reference (so nothing can be decremented safely) but the provider must
   * still be freed — e.g. a delivery that succeeded.
   */
  reconcileAvailability: (providerId) => syncAvailability(providerId, null),
  incrementWorkload,
  decrementWorkload,
  completeDelivery
};
