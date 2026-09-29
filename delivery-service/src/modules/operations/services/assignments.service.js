const assignmentsRepo = require('../repositories/assignments.repository');
const batchesRepo = require('../repositories/assignmentBatches.repository');
const providersService = require('../../providers/services/providers.service');
const deliveryServicesService = require('../../locations-expansion/services/deliveryServices.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const routesService = require('../../locations-expansion/services/routes.service');
const deliveriesService = require('../../delivery-fulfillment/services/delivery-fulfillment.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const trackingRepo = require('../../tracking/repositories/tracking.repository');

const ACTIVE_DELIVERY_STATUSES = ['pending', 'assigned', 'pickup', 'in_transit'];
const TERMINAL_DELIVERY_STATUSES = ['delivered', 'failed', 'cancelled'];

function assertAssignable(delivery) {
  if (!delivery) throw Object.assign(new Error('Delivery not found'), { status: 404 });
  if (TERMINAL_DELIVERY_STATUSES.includes(delivery.status)) {
    throw Object.assign(
      new Error(`Delivery is ${delivery.status} and cannot receive a new assignment`),
      { status: 400 },
    );
  }
}



async function createAssignment(data) {
  const delivery = await deliveriesService.getDelivery(data.deliveryId);
  assertAssignable(delivery);

  const existingActive = await assignmentsRepo.findActiveByDeliveryId(data.deliveryId);
  if (existingActive.length > 0) {
    throw Object.assign(new Error('Delivery already has an active assignment'), { status: 409 });
  }
  // The dispatch flow (AssignmentBatch) is a second holder — never double-book.
  const activeBatches = await batchesRepo.findActiveByDeliveryIds([String(data.deliveryId)]);
  if (activeBatches.length > 0) {
    throw Object.assign(new Error('Delivery already has an active assignment'), { status: 409 });
  }

  const provider = await providersService.getProvider(data.providerId);
  const destSector = delivery.destination && delivery.destination.sectorId ? String(delivery.destination.sectorId) : null;
  const destZone = delivery.destination && delivery.destination.zoneId ? String(delivery.destination.zoneId) : null;

  const eligibility = providersService.isProviderEligible(provider, { 
    zoneId: destZone,
    serviceId: data.serviceId || delivery.serviceId
  });
  if (!eligibility.eligible) {
    throw Object.assign(new Error(`Provider not eligible: ${eligibility.reason}`), { status: 400 });
  }
  
  if (destSector && provider.sectorId && String(provider.sectorId) !== destSector) {
    throw Object.assign(new Error('Delivery actor does not serve this sector'), { status: 400 });
  }

  const service = data.serviceId ? await deliveryServicesService.getService(data.serviceId) : null;
  let zoneId = data.zoneId || (delivery.destination && delivery.destination.zoneId) || null;
  if (zoneId) {
    try { await zonesService.getZone(zoneId); }
    catch { throw Object.assign(new Error('Invalid delivery zone'), { status: 400 }); }
  } else if (delivery.destination && delivery.destination.locationId) {
    const destZones = await zonesService.findZoneForLocation(delivery.destination.locationId);
    zoneId = destZones.length > 0 ? destZones[0]._id : null;
  }

  const route = await routesService.findRouteByEndpoints(delivery.origin.locationId, delivery.destination.locationId);

  let assignment;
  try {
    assignment = await assignmentsRepo.create({
      deliveryId: data.deliveryId, providerId: data.providerId,
      serviceId: data.serviceId || (service && service._id) || null, zoneId,
      hubId: data.hubId || null, routeId: route ? route._id : null,
      status: 'pending', assignedAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      notes: data.notes || '',
    });
  } catch (err) {
    // Partial unique index on (deliveryId, active status) — the other admin won.
    if (err && err.code === 11000) {
      throw Object.assign(new Error('Delivery already has an active assignment'), { status: 409 });
    }
    throw err;
  }

  const now = new Date();
  await deliveriesRepo.updateFields(data.deliveryId, {
    status: 'assigned',
    providerId: data.providerId,
    assignmentId: assignment._id,
    assignedAt: now,
    ...(zoneId ? { 'destination.zoneId': zoneId } : {}),
  });
  // setProviderStatus is automatically handled by incrementWorkload if capacity is full
  try {
    await providersService.incrementWorkload(data.providerId, assignment._id, null);
  } catch (err) {
    await assignmentsRepo.updateFields(assignment._id, { status: 'cancelled' });
    throw err;
  }
  await trackingRepo.create({
    deliveryId: data.deliveryId, providerId: data.providerId,
    status: 'assigned', note: 'Assigned to delivery actor', timestamp: now,
  }).catch(() => null);

  return assignmentsRepo.findById(assignment._id);
}

async function automaticAssignment(deliveryId) {
  const delivery = await deliveriesService.getDelivery(deliveryId);
  assertAssignable(delivery);
  const destZones = await zonesService.findZoneForLocation(delivery.destination.locationId);
  if (destZones.length === 0) throw Object.assign(new Error('No delivery zone for destination'), { status: 404 });
  const zoneId = destZones[0]._id;
  let serviceId = delivery.serviceId;
  if (!serviceId) {
    const result = await deliveryServicesService.findServiceForDelivery(delivery.origin.locationId, delivery.destination.locationId);
    serviceId = result.services[0]._id;
  }
  const available = await providersService.findAvailableForAssignment(serviceId, zoneId);
  if (available.length === 0) throw Object.assign(new Error('No available providers'), { status: 404 });
  return createAssignment({ deliveryId, providerId: available[0]._id, serviceId, zoneId });
}

async function getAssignment(id) {
  const a = await assignmentsRepo.findById(id);
  if (!a) throw Object.assign(new Error('Assignment not found'), { status: 404 });
  return a;
}

async function respondToAssignment(id, accepted, providerId) {
  const assignment = await getAssignment(id);
  if (assignment.status !== 'pending') throw Object.assign(new Error('Assignment is not pending'), { status: 400 });
  if (assignment.providerId.toString() !== providerId) throw Object.assign(new Error('Not authorized'), { status: 403 });
  if (new Date() > assignment.expiresAt) {
    await assignmentsRepo.updateFields(id, { status: 'expired' });
    await providersService.decrementWorkload(providerId, id, null);
    throw Object.assign(new Error('Assignment has expired'), { status: 410 });
  }
  if (accepted) {
    await assignmentsRepo.updateFields(id, { status: 'accepted', respondedAt: new Date() });
    return assignmentsRepo.findById(id);
  }
  await assignmentsRepo.updateFields(id, { status: 'rejected', respondedAt: new Date(), rejectionReason: 'Rejected by provider' });
  // Free the actor and reopen the delivery for reassignment
  await providersService.decrementWorkload(providerId, id, null);
  await deliveriesRepo.updateFields(assignment.deliveryId, {
    status: 'pending', providerId: null, assignmentId: null,
  });
  return assignmentsRepo.findById(id);
}

async function reassign(deliveryId, newProviderId) {
  const delivery = await deliveriesService.getDelivery(deliveryId);
  assertAssignable(delivery);
  // Batch-held orders must be reassigned from the batch, not here.
  const activeBatches = await batchesRepo.findActiveByDeliveryIds([String(deliveryId)]);
  if (activeBatches.length > 0) {
    throw Object.assign(new Error('Delivery already has an active assignment'), { status: 409 });
  }
  const previousProviderId = delivery.providerId;
  const oldAssignments = await assignmentsRepo.findActiveByDeliveryId(deliveryId);
  await assignmentsRepo.cancelActiveByDelivery(deliveryId);
  if (previousProviderId && String(previousProviderId) !== String(newProviderId)) {
    if (oldAssignments.length > 0) {
      for (const a of oldAssignments) {
        await providersService.decrementWorkload(previousProviderId, a._id, null);
      }
    }
  }
  await deliveriesRepo.updateFields(deliveryId, {
    status: 'reassigned', reassignedAt: new Date(),
  });
  const assignment = await createAssignment({ deliveryId, providerId: newProviderId });
  return assignment;
}

async function getAssignments(filter = {}, options = {}) {
  const assignments = await assignmentsRepo.findAll(filter, options);
  const total = await assignmentsRepo.count(filter);
  const limit = options.limit || 50;
  const skip = options.skip || 0;
  return {
    assignments,
    count: assignments.length,
    total,
    page: Math.floor(skip / limit) + 1,
    limit,
    totalPages: Math.ceil(total / limit) || 0,
  };
}

module.exports = { createAssignment, automaticAssignment, getAssignment, respondToAssignment, reassign, getAssignments };
