const providersRepo = require('../repositories/providers.repository');
const availabilityService = require('./provider-availability.service');
const capacityService = require('./provider-capacity.service');
const coverageService = require('./provider-coverage.service');
const eligibilityService = require('./provider-eligibility.service');
const auditClient = require('../../../shared/utils/audit-client');
const identityClient = require('../../../shared/utils/identity-client');

async function createProvider(data, actor) {
  if (data.identityUserId) {
    const existing = await providersRepo.findByIdentityUserId(data.identityUserId);
    if (existing) throw Object.assign(new Error('Provider already exists for this user'), { status: 409 });
  }
  
  // Clean restricted fields on creation if not from admin?
  // Assume admin creation or controlled registration
  const provider = await providersRepo.create(data);

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

async function updateProvider(id, fields, actor) {
  await getProvider(id);
  
  // Validation for vehicle type could go here if needed
  
  const provider = await providersRepo.updateFields(id, fields);
  
  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: 'PROVIDER_UPDATED',
      targetEntity: 'provider',
      targetId: id,
      adminId: actor?.id,
      adminName: actor?.name
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
