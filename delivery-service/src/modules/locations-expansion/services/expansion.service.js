const locationsRepo = require('../repositories/locations.repository');
const zonesRepo = require('../repositories/zones.repository');
const routesRepo = require('../repositories/routes.repository');
const deliveryServicesRepo = require('../repositories/deliveryServices.repository');
const auditClient = require('../../../shared/utils/audit-client');

const EXPANSION_TRANSITIONS = {
  planned: ['preparing', 'suspended', 'closed'],
  preparing: ['testing', 'suspended', 'closed'],
  testing: ['active', 'suspended', 'closed'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: []
};

async function changeExpansionStatus(locationId, newStatus, actor) {
  const loc = await locationsRepo.findById(locationId);
  if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });

  const currentStatus = loc.expansionStatus;
  if (currentStatus === newStatus) return loc;

  const allowed = EXPANSION_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw Object.assign(new Error(`Invalid expansion status transition: ${currentStatus} -> ${newStatus}`), { status: 409 });
  }

  // Pre-activation check
  if (newStatus === 'active') {
    const readiness = await checkReadiness(locationId);
    if (!readiness.ready) {
      throw Object.assign(new Error('Location is not ready for activation: ' + readiness.blockingReasons.join(', ')), { status: 400 });
    }
    // Also require location to be active (isActive=true)
    if (!loc.isActive) {
      throw Object.assign(new Error('Cannot activate expansion for an inactive location'), { status: 400 });
    }
  }

  const updated = await locationsRepo.updateFields(locationId, { expansionStatus: newStatus });

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: `LOCATION_EXPANSION_CHANGED`,
      targetEntity: 'location',
      targetId: locationId,
      adminId: actor ? actor.id : null,
      adminName: actor ? actor.name : null,
      newValue: { expansionStatus: newStatus },
      oldValue: { expansionStatus: currentStatus }
    }).catch(() => null);
  }

  return updated;
}

async function checkReadiness(locationId) {
  const loc = await locationsRepo.findById(locationId);
  if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });

  const checks = {
    locationActive: loc.isActive,
    serviceability: loc.serviceability && loc.serviceability.serviceable,
    zone: false,
    hub: false,
    route: false,
    deliveryService: false,
  };

  const blockingReasons = [];

  if (!checks.locationActive) blockingReasons.push('Location is inactive');
  if (!checks.serviceability) blockingReasons.push('Location serviceability is not enabled');

  // Check zones
  const zones = await zonesRepo.findAll({ 'locations': locationId, isActive: true });
  if (zones && zones.length > 0) {
    checks.zone = true;
  } else {
    blockingReasons.push('No active zone covers this location');
  }

  // Check routes (either origin or destination)
  const routes = await routesRepo.findAll({
    $or: [{ 'origin.locationId': locationId }, { 'destination.locationId': locationId }],
    status: 'active'
  });
  if (routes && routes.length > 0) {
    checks.route = true;
  } else {
    blockingReasons.push('No active delivery route covers this location');
  }

  // Check delivery services (just check if there is at least one active global or zone-specific service)
  const services = await deliveryServicesRepo.findAll({ isActive: true });
  if (services && services.length > 0) {
    // If any service applies to all or intersects with our zones
    const applicable = services.some(s => {
      if (!s.zones || s.zones.length === 0) return true;
      if (zones) return s.zones.some(z => zones.map(zObj => String(zObj._id)).includes(String(z)));
      return false;
    });
    if (applicable) checks.deliveryService = true;
    else blockingReasons.push('No active delivery service is configured for this location/zone');
  } else {
    blockingReasons.push('No active delivery service is available');
  }

  // Check hub - requirement depends on business logic, let's say it's required if it's a sector or above
  if (loc.type !== 'community' && loc.type !== 'village' && loc.type !== 'other') {
     if (loc.hub && loc.hub.isHub && loc.hub.operatingStatus === 'active') {
       checks.hub = true;
     } else {
       // Look if any parent has a hub, or if the zone has a hub
       let hasHub = false;
       if (zones && zones.some(z => z.hubId)) hasHub = true;
       if (hasHub) {
         checks.hub = true;
       } else {
         blockingReasons.push('Required hub is not active or missing in the zone');
       }
     }
  } else {
    checks.hub = true; // Not strictly required for small children, they inherit zone hub
  }

  const ready = checks.locationActive && checks.serviceability && checks.zone && checks.route && checks.deliveryService && checks.hub;

  return {
    locationId,
    ready,
    checks,
    blockingReasons
  };
}

module.exports = {
  changeExpansionStatus,
  checkReadiness
};
