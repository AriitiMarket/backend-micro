const providersRepo = require('../repositories/providers.repository');

/**
 * Centralized eligibility rule check.
 * 
 * @param {Object} provider - The provider document
 * @param {Object} constraints - The constraints { serviceId, zoneId, hubId, routeId, weight }
 */
function isProviderEligible(provider, constraints = {}) {
  if (!provider) return { eligible: false, reason: 'Provider does not exist' };
  
  // 1. Basic Operational State
  if (provider.status === 'suspended') return { eligible: false, reason: 'Provider is suspended' };
  if (provider.status === 'offline' || !provider.availability?.isOnline) {
    return { eligible: false, reason: 'Provider is offline' };
  }
  if (!['available', 'busy'].includes(provider.status)) {
    return { eligible: false, reason: `Provider status ${provider.status} is not assignable` };
  }

  // 2. Capacity Constraints (docs missing the field fall back to the schema default)
  const maxAssignments = Number.isFinite(provider.maxActiveAssignments) ? provider.maxActiveAssignments : 3;
  if ((provider.activeDeliveries ?? 0) >= maxAssignments) {
    return { eligible: false, reason: 'Provider maximum assignment limit reached' };
  }
  if (constraints.weight && provider.maxCapacityKg && constraints.weight > provider.maxCapacityKg) {
    return { eligible: false, reason: 'Provider weight capacity exceeded' };
  }

  // 3. Service Coverage
  if (constraints.serviceId && String(provider.serviceId) !== String(constraints.serviceId)) {
    return { eligible: false, reason: 'Provider does not support the required service' };
  }

  // 4. Geographic Coverage (Zone)
  if (constraints.zoneId) {
    const isPrimaryZone = String(provider.zoneId) === String(constraints.zoneId);
    const inZoneList = provider.zoneIds && provider.zoneIds.some(z => String(z) === String(constraints.zoneId));
    if (!isPrimaryZone && !inZoneList) {
      return { eligible: false, reason: 'Provider does not cover the required zone' };
    }
  }

  // 5. Hub Coverage
  if (constraints.hubId && String(provider.hubId) !== String(constraints.hubId)) {
    return { eligible: false, reason: 'Provider does not cover the required hub' };
  }

  return { eligible: true };
}

async function checkEligibilityById(providerId, constraints = {}) {
  const provider = await providersRepo.findById(providerId);
  if (!provider) return { eligible: false, reason: 'Provider not found' };
  return isProviderEligible(provider, constraints);
}

module.exports = {
  isProviderEligible,
  checkEligibilityById
};
