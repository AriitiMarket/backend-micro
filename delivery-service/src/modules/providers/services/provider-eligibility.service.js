const providersRepo = require('../repositories/providers.repository');

/**
 * Centralized eligibility rule check.
 *
 * ACCOUNT vs AVAILABILITY: this function answers one question — "may this
 * provider receive a NEW assignment right now?". That needs BOTH axes to be
 * green:
 *
 *   account status   ACTIVE  (not pending / rejected / deactivated)
 *   availability     AVAILABLE + online, and under the capacity limit
 *
 * `force` (ignoreCoverage) relaxes ONLY the geographic Zone/Port coverage —
 * it is the backend switch behind the admin's explicit "Force Assign". It never
 * relaxes the account, availability or capacity rules: a deactivated or busy
 * provider stays ineligible even when the admin forces an assignment.
 *
 * @param {Object} provider - The provider document
 * @param {Object} constraints - { serviceId, zoneId, portId, routeId, weight, ignoreCoverage }
 */
function isProviderEligible(provider, constraints = {}) {
  if (!provider) return { eligible: false, reason: 'Provider does not exist' };

  // 1. Account status — a provider the admin deactivated must never receive work.
  if (provider.status === 'suspended') return { eligible: false, reason: 'Provider account is deactivated' };
  if (provider.status === 'pending') return { eligible: false, reason: 'Provider is not approved yet' };
  if (provider.status === 'rejected') return { eligible: false, reason: 'Provider application was rejected' };

  // 2. Availability — provider/system controlled, read here, never set by the admin.
  if (provider.status === 'offline' || !provider.availability?.isOnline) {
    return { eligible: false, reason: 'Provider is offline' };
  }
  // BUSY is not eligible for a NEW assignment: the provider is already on work
  // (at capacity / handling deliveries). It flips back to `available` through
  // the capacity service as work completes.
  if (provider.status !== 'available') {
    return { eligible: false, reason: `Provider status ${provider.status} is not assignable` };
  }

  // 3. Capacity Constraints (docs missing the field fall back to the schema default)
  const maxAssignments = Number.isFinite(provider.maxActiveAssignments) ? provider.maxActiveAssignments : 3;
  if ((provider.activeDeliveries ?? 0) >= maxAssignments) {
    return { eligible: false, reason: 'Provider maximum assignment limit reached' };
  }
  if (constraints.weight && provider.maxCapacityKg && constraints.weight > provider.maxCapacityKg) {
    return { eligible: false, reason: 'Provider weight capacity exceeded' };
  }

  // 4. Service Coverage
  if (constraints.serviceId && String(provider.serviceId) !== String(constraints.serviceId)) {
    return { eligible: false, reason: 'Provider does not support the required service' };
  }

  // 5. Geographic coverage (Zone + Port) — skipped entirely for a forced
  // assignment, which is an explicit exception to these rules.
  if (constraints.ignoreCoverage) return { eligible: true };

  // 5a. Zone — the real delivery area; a provider outside it is not eligible.
  if (constraints.zoneId) {
    const isPrimaryZone = String(provider.zoneId) === String(constraints.zoneId);
    const inZoneList = provider.zoneIds && provider.zoneIds.some(z => String(z) === String(constraints.zoneId));
    if (!isPrimaryZone && !inZoneList) {
      return { eligible: false, reason: 'Provider does not cover the required zone' };
    }
  }

  // 5b. Port — the local point inside the zone. A provider that works a
  // DIFFERENT port is an exception (force assign); a provider with no port
  // restriction set operates anywhere in their zone and stays eligible.
  if (constraints.portId && provider.portId && String(provider.portId) !== String(constraints.portId)) {
    return { eligible: false, reason: 'Provider does not serve the required port' };
  }

  return { eligible: true };
}

async function checkEligibilityById(providerId, constraints = {}) {
  const provider = await providersRepo.findById(providerId);
  if (!provider) return { eligible: false, reason: 'Provider not found' };
  return isProviderEligible(provider, constraints);
}

/**
 * The ONE provider filter for assignment. Admins/Controllers must call this —
 * duplicating status/zone/availability checks elsewhere is how offers land on
 * deactivated or offline providers.
 *
 * `delivery.ignoreCoverage: true` opts into the force-assignment exception
 * (everything except account/availability/capacity is skipped).
 *
 * @param {Object} delivery - { zoneId, portId, serviceId, paymentAmount, ignoreCoverage }
 * @param {Array}  providers - candidate provider documents
 */
function findEligibleProviders(delivery = {}, providers = []) {
  const constraints = {
    zoneId: delivery.destination?.zoneId || delivery.zoneId,
    portId: delivery.destination?.portId || delivery.portId || null,
    serviceId: delivery.serviceId,
    ignoreCoverage: Boolean(delivery.ignoreCoverage),
  };
  const deliveryPortId = constraints.portId;
  const eligible = (providers || []).filter((p) => isProviderEligible(p, constraints).eligible);
  if (!deliveryPortId || constraints.ignoreCoverage) return eligible;
  // Providers that normally work the delivery's port come first.
  const servesPort = (p) => p.portId && String(p.portId) === String(deliveryPortId);
  return [...eligible.filter(servesPort), ...eligible.filter((p) => !servesPort(p))];
}

module.exports = {
  isProviderEligible,
  checkEligibilityById,
  findEligibleProviders,
};
