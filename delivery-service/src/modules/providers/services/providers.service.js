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
  'serviceId', 'sectorId', 'hubId', 'zoneId', 'zoneIds', 'maxCapacityKg',
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

async function setProviderStatus(id, status, actor) {
  const provider = await getProvider(id);
  
  const allowedTransitions = {
    pending: ['available', 'suspended', 'offline'],
    available: ['busy', 'offline', 'suspended'],
    busy: ['available', 'offline', 'suspended'], // typically via capacity though
    offline: ['available', 'busy', 'suspended'],
    suspended: ['offline', 'pending']
  };

  const allowed = allowedTransitions[provider.status] || [];
  if (!allowed.includes(status)) {
    throw Object.assign(new Error(`Invalid status transition: ${provider.status} -> ${status}`), { status: 409 });
  }

  const updated = await providersRepo.updateFields(id, { status });

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: `PROVIDER_${status.toUpperCase()}`,
      targetEntity: 'provider',
      targetId: id,
      adminId: actor?.id,
      adminName: actor?.name
    }).catch(() => null);
  }

  return updated;
}

async function approveProvider(id, actor) {
  return setProviderStatus(id, 'offline', actor); // Approved to offline, then they go online themselves
}

/**
 * Reject a provider application: suspend the record and store the reason so the
 * applicant's status page can show why. The Provider status enum has no
 * `rejected` member, so `suspended` is the terminal "not approved" state (this
 * is what the admin reject route already did).
 */
async function rejectProvider(id, reason, actor) {
  const provider = await getProvider(id);
  const metadata = { ...(provider.metadata || {}) };
  metadata.application = {
    ...(metadata.application || {}),
    rejectionReason: reason || 'Rejected by admin',
    decidedAt: new Date(),
  };
  const updated = await providersRepo.updateFields(id, { status: 'suspended', metadata });

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_REJECTED',
      level: 'WARNING',
      targetEntity: 'provider',
      targetId: id,
      reason: metadata.application.rejectionReason,
      adminId: actor?.id,
      adminName: actor?.name,
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
  return { ...result, blocking: !result.granted };
}

async function setOnline(id, isOnline, actor) {
  return availabilityService.setOnlineStatus(id, isOnline, actor);
}

async function incrementWorkload(id, workloadId, actor) { return capacityService.incrementWorkload(id, workloadId, actor); }
async function decrementWorkload(id, workloadId, actor) { return capacityService.decrementWorkload(id, workloadId, actor); }
async function completeDelivery(id, workloadId, actor) { return capacityService.completeDelivery(id, workloadId, actor); }

async function getProvidersByZone(zoneId) { return providersRepo.findByZone(zoneId); }
async function getProvidersByHub(hubId) { return providersRepo.findByHub(hubId); }

module.exports = {
  createProvider, getProvider, updateProvider, getProviders, countProviders,
  getAvailableProviders, findAvailableForAssignment, setProviderStatus,
  approveProvider, rejectProvider, provisionProviderAccount, setOnline,
  incrementWorkload, decrementWorkload,
  completeDelivery, getProvidersByZone, getProvidersByHub,
  
  // Re-export specific services for direct usage
  checkEligibilityById: eligibilityService.checkEligibilityById,
  isProviderEligible: eligibilityService.isProviderEligible,
  updateCoverage: coverageService.updateCoverage,
  updateLocation: availabilityService.updateLocation
};
