const assignmentsRepo = require('../repositories/assignments.repository');
const batchesRepo = require('../repositories/assignmentBatches.repository');
const providersService = require('../../providers/services/providers.service');
const deliveryServicesService = require('../../locations-expansion/services/deliveryServices.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const routesService = require('../../locations-expansion/services/routes.service');
const deliveriesService = require('../../delivery-fulfillment/services/delivery-fulfillment.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const { transitionDeliveryStatus } = require('../../delivery-fulfillment/services/delivery-status.service');
const { BLOCKED_DELIVERY_STATUSES } = require('../../../shared/constants');

function assertAssignable(delivery) {
  if (!delivery) throw Object.assign(new Error('Delivery not found'), { status: 404 });
  // BLOCKED (not TERMINAL) is the right test here: a completed, failed or
  // cancelled delivery must never take a new rider. `failed` can still be
  // retried, but retrying means requeueing to the ready pool first, not
  // reassigning the corpse.
  if (BLOCKED_DELIVERY_STATUSES.includes(delivery.status)) {
    throw Object.assign(
      new Error(`Delivery is ${delivery.status} and cannot receive a new assignment`),
      { status: 400 },
    );
  }
}

/**
 * Force assignment is an EXCEPTION to the Zone/Port coverage rules, so it may
 * never be implicit:
 *
 *   - an explicit `forceAssignment: true` flag,
 *   - a non-empty `reason` (recorded on the assignment and in the audit trail),
 *   - the admin's authenticated identity (`actorId` — set by the controller
 *     from the request's user, never trusted from the request body).
 *
 * The FRONTEND hiding ineligible providers is not enforcement; this check is.
 * Returns the normalized force payload used by the rest of the flow.
 */
function assertForceAssignment(data) {
  const forced = data.forceAssignment === true || data.forceAssignment === 'true';
  if (!forced) return null;
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (!reason) {
    throw Object.assign(
      new Error('Force assignment requires a reason'),
      { status: 400, code: 'FORCE_REASON_REQUIRED' },
    );
  }
  if (!data.actorId) {
    throw Object.assign(
      new Error('Force assignment requires an admin identity'),
      { status: 403, code: 'FORCE_ADMIN_REQUIRED' },
    );
  }
  return { reason, adminId: String(data.actorId), at: new Date() };
}

async function createAssignment(data) {
  const delivery = await deliveriesService.getDelivery(data.deliveryId);
  assertAssignable(delivery);

  // Validate the exception BEFORE touching any state: a force request without
  // a reason or an admin identity must not create (or release) anything.
  const force = assertForceAssignment(data);

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
  const destZone = delivery.destination && delivery.destination.zoneId ? String(delivery.destination.zoneId) : null;
  // A delivery carries its port in `destination.portId`; older records also have
  // a top-level `portId`. Both are read so the Port rule can never be silently
  // skipped by a record that only has the legacy field.
  const destPortRaw = (delivery.destination && delivery.destination.portId) || delivery.portId || null;
  const destPort = destPortRaw ? String(destPortRaw) : null;

  // Normal assignment enforces Zone AND Port; a forced one skips coverage only —
  // account status, availability and capacity are still verified below.
  const eligibility = providersService.isProviderEligible(provider, {
    zoneId: destZone,
    portId: destPort,
    serviceId: data.serviceId || delivery.serviceId,
    ignoreCoverage: Boolean(force),
  });
  if (!eligibility.eligible) {
    throw Object.assign(new Error(`Provider not eligible: ${eligibility.reason}`), { status: 400 });
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

  // The delivery's OWN geography is the operational record (MVP §12): an
  // assignment never rewrites it. The destination port is never touched — a
  // force-assigned provider from another port does not move the delivery's port
  // to theirs — and the zone below is only backfilled when missing.
  const originalZoneId = delivery.destination?.zoneId ?? null;
  const originalPortId = delivery.destination?.portId ?? null;

  let assignment;
  try {
    assignment = await assignmentsRepo.create({
      deliveryId: data.deliveryId, providerId: data.providerId,
      serviceId: data.serviceId || (service && service._id) || null, zoneId,
      portId: data.portId || null, routeId: route ? route._id : null,
      status: 'pending', assignedAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      notes: data.notes || '',
      // Exception trail (false / empty for a normal in-area assignment).
      forcedAssignment: Boolean(force),
      forceReason: force ? force.reason : '',
      forcedBy: force ? force.adminId : null,
      forcedAt: force ? force.at : null,
      originalZoneId: originalZoneId || null,
      originalPortId: originalPortId || null,
      providerZoneId: provider.zoneId || null,
      providerPortId: provider.portId || null,
    });
  } catch (err) {
    // Partial unique index on (deliveryId, active status) — the other admin won.
    if (err && err.code === 11000) {
      throw Object.assign(new Error('Delivery already has an active assignment'), { status: 409 });
    }
    throw err;
  }

  // Capacity is reserved BEFORE the delivery moves. The repository's atomic
  // $expr guard is the only check that cannot oversubscribe a provider when two
  // admins assign work at the same moment; if it loses the race the delivery
  // must be left exactly as it was, so nothing is written before it succeeds.
  try {
    await providersService.incrementWorkload(data.providerId, assignment._id, null);
  } catch (err) {
    await assignmentsRepo.updateFields(assignment._id, { status: 'cancelled' });
    throw err;
  }

  const previousStatus = delivery.status;
  const previousProviderId = delivery.providerId || null;
  const previousAssignmentId = delivery.assignmentId || null;
  try {
    // Ownership first, so the state-machine side effects (milestone, tracking,
    // Commerce notification) carry the provider and the assignment reference.
    const ownership = { providerId: data.providerId, assignmentId: assignment._id };
    // Backfill ONLY a missing zone/port. An existing zone/port is the
    // delivery's real area and is never overwritten — not even by the assigned
    // provider's own zone/port (MVP §12), forced or not.
    if (zoneId && !originalZoneId) ownership['destination.zoneId'] = zoneId;
    if (provider.portId && !originalPortId) ownership['destination.portId'] = provider.portId;
    await deliveriesRepo.updateFields(data.deliveryId, ownership);
    // One state machine for every assignment path: the status change, its
    // milestone (`assignedAt`) and the downstream notifications are identical
    // whether a provider was assigned one delivery or a whole batch.
    await transitionDeliveryStatus(data.deliveryId, 'assigned', {
      id: data.actorId || null, name: data.actorName || null, role: data.actorRole || 'ADMIN',
    }, {
      note: force
        ? `Force assigned outside the delivery zone/port: ${force.reason}`
        : (data.notes || 'Assigned to delivery provider'),
    });
  } catch (err) {
    // Never leave a delivery `assigned` to a provider that holds no work: it
    // would be invisible in the ready pool and impossible to dispatch again.
    await providersService.decrementWorkload(data.providerId, assignment._id, null).catch(() => null);
    await assignmentsRepo.updateFields(assignment._id, { status: 'cancelled' });
    await deliveriesRepo.updateFields(data.deliveryId, {
      status: previousStatus, providerId: previousProviderId, assignmentId: previousAssignmentId,
    }).catch(() => null);
    // Restore the delivery's OWN zone/port (never `null`): a failed assignment
    // must leave the geographic record exactly as it found it.
    await deliveriesRepo.updateFields(data.deliveryId, {
      'destination.zoneId': originalZoneId, 'destination.portId': originalPortId,
    }).catch(() => null);
    throw err;
  }

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

/** Expire stale offers and release their deliveries so an expired offer can
 * never leave a delivery stuck `assigned` to a provider who never accepted. */
async function expireStaleOffers() {
  const stale = await assignmentsRepo.findPendingExpired();
  let expired = 0;
  for (const a of stale) {
    try {
      await assignmentsRepo.updateFields(a._id, { status: 'expired', respondedAt: new Date() });
      await providersService.decrementWorkload(a.providerId, a._id, null).catch(() => null);
      const delivery = await deliveriesService.getDelivery(a.deliveryId).catch(() => null);
      if (delivery && delivery.status === 'assigned' && String(delivery.assignmentId) === String(a._id)) {
        await transitionDeliveryStatus(a.deliveryId, 'pending', { role: 'SYSTEM' }, { note: 'Assignment offer expired' });
        await deliveriesRepo.updateFields(a.deliveryId, { providerId: null, assignmentId: null });
      }
      expired += 1;
    } catch (err) {
      console.warn('[assignments] expireStaleOffers skip', a._id, err.message);
    }
  }
  return expired;
}

async function respondToAssignment(id, accepted, providerId) {
  const assignment = await getAssignment(id);
  if (assignment.status !== 'pending') throw Object.assign(new Error('Assignment is not pending'), { status: 400 });
  // `assignment.providerId` is an ObjectId and the resolved provider id arrives
  // as a string: a strict comparison rejected EVERY provider response with 403,
  // so no provider could ever accept or decline an assignment.
  if (String(assignment.providerId) !== String(providerId)) {
    throw Object.assign(new Error('This assignment belongs to another provider'), { status: 403 });
  }
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
  // Free the provider's reserved capacity, then release the delivery back to the
  // ready pool through the state machine so the release is part of its history
  // and Commerce is told about it.
  await providersService.decrementWorkload(providerId, id, null);
  await transitionDeliveryStatus(assignment.deliveryId, 'pending', {
    id: String(providerId), role: 'PROVIDER',
  }, { note: 'Assignment rejected by provider' });
  await deliveriesRepo.updateFields(assignment.deliveryId, { providerId: null, assignmentId: null });
  return assignmentsRepo.findById(id);
}

async function reassign(deliveryId, newProviderId, actor = null, extra = {}) {
  const delivery = await deliveriesService.getDelivery(deliveryId);
  assertAssignable(delivery);
  // A forced reassignment goes through the same reason/admin validation as a
  // first assignment — validate BEFORE releasing the outgoing provider.
  const force = assertForceAssignment({
    forceAssignment: extra.forceAssignment, reason: extra.reason,
    actorId: actor && actor.id,
  });
  // Batch-held orders must be reassigned from the batch, not here.
  const activeBatches = await batchesRepo.findActiveByDeliveryIds([String(deliveryId)]);
  if (activeBatches.length > 0) {
    throw Object.assign(new Error('Delivery already has an active assignment'), { status: 409 });
  }

  // Step 1 — move the delivery to `reassigned` through the state machine. That
  // single call stamps the milestone, releases the outgoing provider's reserved
  // capacity, records the event in history and tells Commerce; writing the field
  // directly would have done none of that and left the release unexplained. A
  // delivery that holds no provider yet has nothing to hand over.
  if (delivery.providerId && delivery.status !== 'reassigned') {
    await transitionDeliveryStatus(deliveryId, 'reassigned', actor, { note: 'Reassigned to another provider' });
  }
  await assignmentsRepo.cancelActiveByDelivery(deliveryId);
  await deliveriesRepo.updateFields(deliveryId, { providerId: null, assignmentId: null });

  // Step 2 — hand it to the new provider through the same path every assignment
  // uses (eligibility, capacity reservation, `assigned` transition).
  const assignment = await createAssignment({
    deliveryId,
    providerId: newProviderId,
    forceAssignment: force ? true : undefined,
    reason: force ? force.reason : undefined,
    actorId: force ? force.adminId : (actor && actor.id) || undefined,
    actorName: actor && actor.name,
    actorRole: actor && actor.role,
  });
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

module.exports = { createAssignment, automaticAssignment, getAssignment, respondToAssignment, reassign, getAssignments, expireStaleOffers };
