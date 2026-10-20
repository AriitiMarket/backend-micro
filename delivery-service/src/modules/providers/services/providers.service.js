const providersRepo = require('../repositories/providers.repository');
const availabilityService = require('./provider-availability.service');
const capacityService = require('./provider-capacity.service');
const coverageService = require('./provider-coverage.service');
const eligibilityService = require('./provider-eligibility.service');
const auditClient = require('../../../shared/utils/audit-client');
const identityClient = require('../../../shared/utils/identity-client');
const { badRequest } = require('../../../shared/errors');

async function createProvider(data, actor) {
  if (data.identityUserId) {
    const existing = await providersRepo.findByIdentityUserId(data.identityUserId);
    if (existing) throw Object.assign(new Error('Provider already exists for this user'), { status: 409 });
  }
  // Workload counters are owned by the capacity service (atomic increments) and
  // must never be seeded from a request body.
  const payload = { ...(data || {}) };
  for (const counter of WORKLOAD_MANAGED_FIELDS) delete payload[counter];
  // Account status and availability are NOT creatable fields. An admin-created
  // provider starts at `pending` exactly like a self-application (approve /
  // reject is a separate, audited action), and availability stays under the
  // provider's own control — a body that tried to seed `available` / `isOnline`
  // would hand the admin the Online/Offline switch this model deliberately
  // keeps out of the admin's hands.
  delete payload.status;
  delete payload.availability;

  const provider = await providersRepo.create(payload);

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_CREATED',
      targetEntity: 'provider',
      targetId: provider._id,
      adminId: actor?.id,
      adminName: actor?.name,
      metadata: { identityUserId: data.identityUserId }
    }).catch(() => null);
  }

  return provider;
}

async function getProvider(id) {
  const provider = await providersRepo.findById(id);
  if (!provider) throw Object.assign(new Error('Provider not found'), { status: 404 });
  return provider;
}

// Fields an administrator may change through the roster endpoint. Everything
// else — the linked identity account, the operational status (its own endpoint
// with its own transition rules) and the capacity counters (owned by the atomic
// capacity service) — is NOT assignable from a request body.
const UPDATABLE_PROVIDER_FIELDS = [
  'name', 'phone', 'email', 'providerType', 'actorType', 'vehicleType', 'plateNumber',
  'serviceId', 'cityId', 'portId', 'zoneId', 'zoneIds', 'maxCapacityKg',
  'maxActiveAssignments', 'rating', 'metadata',
];
const WORKLOAD_MANAGED_FIELDS = ['activeDeliveries', 'currentWorkloadIds', 'completedDeliveries', 'identityUserId'];

function assertUpdatableFields(fields) {
  const unknown = Object.keys(fields || {}).filter((key) => !UPDATABLE_PROVIDER_FIELDS.includes(key));
  if (unknown.length > 0) {
    // A typed AppError: the rejection carries the same `{ success, code, message,
    // errors }` shape as every other validation failure in the service.
    throw badRequest(`Unsupported provider field(s): ${unknown.join(', ')}`, 'UNSUPPORTED_FIELD');
  }
  if (fields.maxActiveAssignments !== undefined && fields.maxActiveAssignments !== null) {
    const value = Number(fields.maxActiveAssignments);
    if (!Number.isInteger(value) || value < 1) {
      throw badRequest('"maxActiveAssignments" must be an integer of at least 1');
    }
  }
  if (fields.maxCapacityKg !== undefined && fields.maxCapacityKg !== null) {
    const value = Number(fields.maxCapacityKg);
    if (!Number.isFinite(value) || value < 0) {
      throw badRequest('"maxCapacityKg" must be a non-negative number');
    }
  }
  return fields;
}

async function updateProvider(id, fields, actor) {
  await getProvider(id);
  const patch = assertUpdatableFields(fields);

  const provider = await providersRepo.updateFields(id, patch);

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_UPDATED',
      targetEntity: 'provider',
      targetId: id,
      adminId: actor?.id,
      adminName: actor?.name,
      newValue: patch,
    }).catch(() => null);
  }

  return provider;
}

async function getProviders(filter = {}, options = {}) { return providersRepo.findAll(filter, options); }
async function countProviders(filter = {}) { return providersRepo.count(filter); }
async function getAvailableProviders(serviceId, zoneId) { return providersRepo.findAvailable(serviceId, zoneId); }

// Keep for legacy, but internally it can use eligibility check logic later or just repo if same
async function findAvailableForAssignment(serviceId, zoneId) { 
  return providersRepo.findAvailableForAssignment(serviceId, zoneId); 
}

// Allowed transitions per status. `rejected` is a terminal REVIEW outcome (the
// applicant may be sent back to `pending` or, rarely, approved later);
// `suspended` is an approved provider taken off the platform.
const ALLOWED_TRANSITIONS = {
  pending: ['available', 'suspended', 'offline', 'rejected'],
  available: ['busy', 'offline', 'suspended', 'rejected'],
  busy: ['available', 'offline', 'suspended', 'rejected'],
  offline: ['available', 'busy', 'suspended', 'rejected'],
  suspended: ['offline', 'pending', 'rejected'],
  rejected: ['pending', 'offline', 'suspended'],
};

/**
 * The account-side meaning of a roster status.
 * null = the membership should not be touched by this transition.
 */
function membershipTargetFor(status) {
  if (status === 'suspended') return 'SUSPENDED';
  if (status === 'rejected') return 'REJECTED';
  if (status === 'pending') return 'PENDING';
  if (status === 'offline' || status === 'available' || status === 'busy') return 'ACTIVE';
  return null;
}

/**
 * Keep the Identity PROVIDER membership in step with the roster status.
 *
 * Suspension/rejection that never reaches Identity leaves the account able to
 * enter the provider workspace with a "suspended" roster record, and a
 * reactivated provider whose membership is still SUSPENDED is locked out — both
 * are the same bug on either side of the boundary. Identity stays the only
 * writer of roles, so this goes over the internal endpoints and is deliberately
 * non-blocking: the roster decision is committed, a transient Identity outage
 * is logged for retry rather than failing the admin's action.
 *
 * @returns {Promise<{synced: boolean, target?: string, reason?: string}>}
 */
async function syncMembershipToIdentity(provider, fromStatus, toStatus) {
  if (!provider || !provider.identityUserId) return { synced: false, reason: 'no linked account' };
  const target = membershipTargetFor(toStatus);
  if (!target) return { synced: false, reason: 'no membership change' };

  // Becoming a working provider from a denied/pending state needs a (re)grant,
  // not a status write: grant-role upserts the membership back to ACTIVE.
  const needsGrant =
    target === 'ACTIVE' && ['pending', 'suspended', 'rejected'].includes(fromStatus);

  // Routine availability flips (available <-> busy <-> offline between two
  // already-active states) never change what the account is allowed to do —
  // skip the round trip instead of writing ACTIVE on every toggle.
  if (target === 'ACTIVE' && !needsGrant) {
    return { synced: false, reason: 'membership already active' };
  }

  try {
    if (needsGrant) {
      const result = await identityClient.grantProviderRole(provider.identityUserId);
      return { synced: Boolean(result.granted), target, reason: result.reason };
    }
    const result = await identityClient.setProviderMembershipStatus(provider.identityUserId, target);
    if (!result.ok) {
      console.warn(
        `[providers] identity membership sync ${target} failed for ${provider.identityUserId}: ${result.reason || result.status}`
      );
      return { synced: false, target, reason: result.reason || String(result.status) };
    }
    return { synced: true, target };
  } catch (err) {
    console.warn(`[providers] identity membership sync ${target} warning: ${err.message}`);
    return { synced: false, target, reason: err.message };
  }
}

async function setProviderStatus(id, status, actor, reason) {
  const provider = await getProvider(id);

  const allowed = ALLOWED_TRANSITIONS[provider.status] || [];
  if (!allowed.includes(status)) {
    throw Object.assign(new Error(`Invalid status transition: ${provider.status} -> ${status}`), { status: 409 });
  }

  const patch = { status };
  // Deactivation is a deliberate admin decision, so its reason is stored on the
  // record (visible in the provider detail) and carried into the audit entry —
  // the same way rejection already stores its reason.
  if (status === 'suspended' && reason) {
    const metadata = { ...(provider.metadata || {}) };
    metadata.deactivationReason = String(reason);
    metadata.deactivatedAt = new Date();
    if (actor && actor.id) metadata.deactivatedBy = String(actor.id);
    patch.metadata = metadata;
  }

  const updated = await providersRepo.updateFields(id, patch);

  const membership = await syncMembershipToIdentity(provider, provider.status, status);

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: `PROVIDER_${status.toUpperCase()}`,
      targetEntity: 'provider',
      targetId: id,
      reason: status === 'suspended' ? (reason || null) : null,
      adminId: actor?.id,
      adminName: actor?.name,
      metadata: { membershipSynced: membership.synced }
    }).catch(() => null);
  }

  return updated;
}

async function approveProvider(id, actor) {
  const provider = await getProvider(id);

  // An approval supersedes any earlier rejection: clear the stored reason so a
  // later admin (or the applicant's status page) never sees a stale one on a
  // live provider.
  const metadata = { ...(provider.metadata || {}) };
  if (metadata.application && (metadata.application.rejectionReason || metadata.application.decidedAt)) {
    const application = { ...metadata.application };
    delete application.rejectionReason;
    delete application.decidedAt;
    metadata.application = application;
    await providersRepo.updateFields(id, { metadata });
  }

  // Approved to offline, then they go online themselves. Identity is synced by
  // setProviderStatus (rejected/suspended -> ACTIVE re-grant).
  return setProviderStatus(id, 'offline', actor);
}

/**
 * Reject a provider application: set the terminal `rejected` status and store
 * the reason so the applicant's status page can show why. Unlike the old
 * behaviour (which wrote `suspended`), `rejected` is re-appliable — the
 * applicant can submit a new application, which returns the record to
 * `pending` for review.
 */
async function rejectProvider(id, reason, actor) {
  const provider = await getProvider(id);
  const metadata = { ...(provider.metadata || {}) };
  metadata.application = {
    ...(metadata.application || {}),
    rejectionReason: reason || 'Rejected by admin',
    decidedAt: new Date(),
  };
  const updated = await providersRepo.updateFields(id, { status: 'rejected', metadata });

  const membership = await syncMembershipToIdentity(provider, provider.status, 'rejected');

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_REJECTED',
      level: 'WARNING',
      targetEntity: 'provider',
      targetId: id,
      reason: metadata.application.rejectionReason,
      adminId: actor?.id,
      adminName: actor?.name,
      metadata: { membershipSynced: membership.synced },
    }).catch(() => null);
  }

  return updated;
}

/**
 * Grant the approved provider the PROVIDER account role in the Identity Service.
 *
 * Provisioning is deliberately separable from the status change so approval can
 * happen only if the account can actually be provisioned — otherwise an approved
 * provider would be locked out of the provider workspace. Providers created
 * directly by an admin have no linked account, which is not an error.
 *
 * @returns {Promise<{granted: boolean, blocking: boolean, status?: number, reason?: string}>}
 */
async function provisionProviderAccount(provider) {
  if (!provider || !provider.identityUserId) {
    return { granted: false, blocking: false, reason: 'Provider has no linked account' };
  }
  const result = await identityClient.grantProviderRole(provider.identityUserId);
  // Only a FAILED call blocks the approval. The grant is idempotent: an account
  // that already holds the PROVIDER membership is the desired end state, not a
  // provisioning error, so re-approving a provider (or approving one who
  // registered with the PROVIDER role up front) must not be reported as a
  // failure. `granted` still says whether THIS call was the one that granted it.
  const callFailed = !(result.status >= 200 && result.status < 300);
  return {
    ...result,
    granted: callFailed ? false : result.granted,
    blocking: callFailed,
    reason: callFailed ? (result.reason || `Identity Service returned ${result.status}`) : result.reason,
  };
}

async function setOnline(id, isOnline, actor) {
  return availabilityService.setOnlineStatus(id, isOnline, actor);
}

async function incrementWorkload(id, workloadId, actor) { return capacityService.incrementWorkload(id, workloadId, actor); }
async function decrementWorkload(id, workloadId, actor) { return capacityService.decrementWorkload(id, workloadId, actor); }
async function completeDelivery(id, workloadId, actor) { return capacityService.completeDelivery(id, workloadId, actor); }
/** Re-derive availability from load without touching the counters (safety net). */
async function reconcileAvailability(id) { return capacityService.reconcileAvailability(id); }

async function getProvidersByZone(zoneId) { return providersRepo.findByZone(zoneId); }
async function getProvidersByPort(portId) { return providersRepo.findByPort(portId); }

module.exports = {
  createProvider, getProvider, updateProvider, getProviders, countProviders,
  getAvailableProviders, findAvailableForAssignment, setProviderStatus,
  approveProvider, rejectProvider, provisionProviderAccount, setOnline,
  incrementWorkload, decrementWorkload, reconcileAvailability,
  completeDelivery, getProvidersByZone, getProvidersByPort,
  
  // Re-export specific services for direct usage
  checkEligibilityById: eligibilityService.checkEligibilityById,
  isProviderEligible: eligibilityService.isProviderEligible,
  findEligibleProviders: eligibilityService.findEligibleProviders,
  updateCoverage: coverageService.updateCoverage,
  updateLocation: availabilityService.updateLocation
};
