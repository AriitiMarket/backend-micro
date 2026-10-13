const mongoose = require('mongoose');
const batchesRepo = require('../repositories/assignmentBatches.repository');
const assignmentsRepo = require('../repositories/assignments.repository');
const providersRepo = require('../../providers/repositories/providers.repository');
const providersService = require('../../providers/services/providers.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const trackingRepo = require('../../tracking/repositories/tracking.repository');
const { transitionDeliveryStatus } = require('../../delivery-fulfillment/services/delivery-status.service');
const {
  ASSIGNMENT_BATCH_TRANSITIONS,
  ACTIVE_ASSIGNMENT_BATCH_STATUSES,
  MAX_BATCH_ORDERS,
  READY_DELIVERY_STATUSES,
  BLOCKED_DELIVERY_STATUSES,
} = require('../../../shared/constants');

// An order may only enter a batch while it is still in the ready pool.
// `READY_DELIVERY_STATUSES` is the canonical ready pool (`pending`); it used to
// be re-spelled here as a literal, which is how dispatch came to disagree with
// the delivery state machine about what "ready for pickup" means.
const ASSIGNABLE_DELIVERY_STATUSES = READY_DELIVERY_STATUSES;

function badRequest(message, extra = {}) {
  return Object.assign(new Error(message), { status: 400, ...extra });
}

function assertTransition(batch, nextStatus) {
  const allowed = ASSIGNMENT_BATCH_TRANSITIONS[batch.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw badRequest(`Invalid assignment transition: ${batch.status} -> ${nextStatus}`);
  }
}

/** Validate one delivery is eligible to join this batch. */
function assertDeliveryEligible(delivery) {
  if (!delivery) throw Object.assign(new Error('Delivery not found'), { status: 404 });
  if (BLOCKED_DELIVERY_STATUSES.includes(delivery.status)) {
    throw badRequest(`Order ${delivery.orderId} is ${delivery.status} and cannot be assigned`);
  }
  if (!ASSIGNABLE_DELIVERY_STATUSES.includes(delivery.status)) {
    throw badRequest(
      `Order ${delivery.orderId} is not ready for pickup (current status: ${delivery.status})`,
    );
  }
}

/**
 * Rider gate, per the product rules: active, available, allowed in the
 * relevant area, and not over capacity. Returns the provider.
 */
async function assertProviderAssignable(providerId, deliveries) {
  const provider = await providersService.getProvider(providerId);
  
  // Use centralized eligibility logic
  const eligibility = providersService.isProviderEligible(provider);
  if (!eligibility.eligible) {
    throw badRequest(`Rider not assignable: ${eligibility.reason}`);
  }

  // Area eligibility — only enforced when the rider has a restricted area.
  const destZones = [
    ...new Set(deliveries.map((d) => d.destination && d.destination.zoneId).filter(Boolean).map(String)),
  ];
  const providerZones = [
    provider.zoneId ? String(provider.zoneId) : null,
    ...(Array.isArray(provider.zoneIds) ? provider.zoneIds.map(String) : []),
  ].filter(Boolean);
  if (providerZones.length > 0 && destZones.length > 0) {
    const uncovered = destZones.filter((z) => !providerZones.includes(z));
    if (uncovered.length > 0) {
      throw badRequest('Rider is not allowed to deliver in one or more selected zones');
    }
  }

  // Capacity — never hand out more active batches than the rider can hold.
  const active = await batchesRepo.findActiveByProviderId(providerId);
  const capacity = Number.isFinite(provider.maxActiveAssignments) ? provider.maxActiveAssignments : 3;
  if (active.length >= capacity) {
    throw badRequest(`Rider has reached the maximum of ${capacity} active assignments`);
  }
  return provider;
}

/** One pickup stop per seller, orders grouped under it. */
function buildPickupPlan(deliveries) {
  const bySeller = new Map();
  deliveries.forEach((d) => {
    const key = String(d.sellerId);
    if (!bySeller.has(key)) {
      bySeller.set(key, {
        sellerId: key,
        sellerName: d.origin && d.origin.shopName ? d.origin.shopName : d.sellerId,
        shopName: d.origin ? d.origin.shopName || '' : '',
        address: d.origin || null,
        orderIds: [],
      });
    }
    bySeller.get(key).orderIds.push(d.orderId);
  });
  return [...bySeller.values()].map((stop, index) => ({
    sequence: index + 1,
    ...stop,
    completed: false,
    completedAt: null,
  }));
}

function appendHistory(status, actor, note) {
  return {
    status,
    at: new Date(),
    actorId: (actor && actor.id) || null,
    actorName: (actor && (actor.name || actor.email)) || '',
    note: note || '',
  };
}

function toPlain(history) {
  return history.map((h) => (h.toObject ? h.toObject() : h));
}

// Proof-of-delivery keys a rider client may send, either nested under
// `proofOfDelivery`/`proof` or directly in the completion payload.
const PROOF_KEYS = [
  'codConfirmed', 'codCollectedAmount', 'photoReference', 'photoUrl',
  'signatureReference', 'signatureUrl', 'recipientName', 'recipientReference',
  'confirmedAt', 'type', 'note',
];

/**
 * Resolve the proof-of-delivery object from a completion payload.
 *
 * Accepted as `{ proofOfDelivery: {...} }`, `{ proof: {...} }` or inline
 * (`{ codConfirmed: true, codCollectedAmount: 500 }`), so a COD confirmation is
 * recorded whichever shape the rider client uses instead of being dropped and
 * failing the completion with PROOF_REQUIRED.
 */
function extractProofOfDelivery(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const nested = payload.proofOfDelivery || payload.proof;
  if (nested && typeof nested === 'object') return nested;
  const inline = {};
  for (const key of PROOF_KEYS) {
    if (payload[key] !== undefined && payload[key] !== null) inline[key] = payload[key];
  }
  return Object.keys(inline).length > 0 ? inline : null;
}

/** Push the batch's per-order statuses down to the underlying deliveries. */
async function syncDeliveryStatuses(batch) {
  for (const entry of batch.deliveries) {
    const delivery = await deliveriesRepo.findById(entry.deliveryId);
    if (!delivery) throw Object.assign(new Error(`Delivery ${entry.deliveryId} not found`), { status: 404 });
    await transitionDeliveryStatus(entry.deliveryId, entry.status, { id: String(batch.providerId), name: batch.providerName, role: 'PROVIDER' }, {
      note: `Assignment ${batch.reference}`,
    }, { deferProviderCompletion: true });
  }
}

/**
 * Create a batch from many ready orders for one rider.
 * Validates EVERY selected order is eligible and the rider can take them all.
 */
async function createBatch({ deliveryIds, providerId, serviceId, routeId, notes, actor, skipConflictFor }) {
  const ids = [...new Set((deliveryIds || []).map(String))];
  if (ids.length === 0) throw badRequest('Select at least one order to assign');
  if (ids.length > MAX_BATCH_ORDERS) {
    throw badRequest(`A single assignment may contain at most ${MAX_BATCH_ORDERS} orders`);
  }

  // Conflict check FIRST: "already on another active assignment" is a more
  // actionable message than the resulting "not ready for pickup" status.
  // `skipConflictFor` lets a reassignment ignore the batch it is replacing.
  const active = await batchesRepo.findActiveByDeliveryIds(ids);
  const conflicting = active.filter((b) => String(b._id) !== String(skipConflictFor));
  if (conflicting.length > 0) {
    const blocked = conflicting.flatMap((b) => b.deliveries.map((d) => d.orderId));
    throw Object.assign(
      new Error(`One or more orders are already assigned to an active assignment (${blocked.join(', ')})`),
      { status: 409 },
    );
  }

  // Same rule against the single-assignment flow — one active holder, ever.
  const activeSingles = await assignmentsRepo.findActiveByDeliveryIds(ids);
  if (activeSingles.length > 0) {
    const held = new Set(activeSingles.map((a) => String(a.deliveryId)));
    const heldIds = ids.filter((id) => held.has(String(id)));
    const heldDeliveries = await Promise.all(heldIds.map((id) => deliveriesRepo.findById(id)));
    const orderIds = heldDeliveries.filter(Boolean).map((d) => d.orderId).join(', ');
    throw Object.assign(
      new Error(`One or more orders are already assigned to an active assignment (${orderIds})`),
      { status: 409 },
    );
  }

  const deliveries = [];
  for (const id of ids) {
    const delivery = await deliveriesRepo.findById(id);
    assertDeliveryEligible(delivery);
    deliveries.push(delivery);
  }

  const provider = await assertProviderAssignable(providerId, deliveries);

  // Reserve capacity first if possible? No, we need batch ID.
  // We'll create the batch and if increment fails, we cancel it.
  //
  // The human reference (DL-2xxx) is generated by reading the newest batch, so
  // two dispatchers creating a batch at the same moment compute the SAME number
  // and one of them dies with `409 Duplicate value for: reference` — which is
  // exactly what two concurrent screens (admin console + rider portal, or two
  // admins) produce. The `reference` index is unique, so the collision is caught
  // by the database and retried here with a freshly generated number.
  const batchDoc = (reference) => ({
    reference,
    providerId: provider._id,
    providerName: provider.name,
    serviceId: serviceId || null,
    routeId: routeId || null,
    zoneIds: [...new Set(deliveries.map((d) => d.destination && d.destination.zoneId).filter(Boolean))],
    status: 'waiting_acceptance',
    deliveries: deliveries.map((d) => ({
      deliveryId: d._id,
      orderId: d.orderId,
      sellerId: String(d.sellerId),
      sellerName: d.origin && d.origin.shopName ? d.origin.shopName : String(d.sellerId),
      shopName: d.origin ? d.origin.shopName || '' : '',
      paymentMethod: d.paymentMethod || 'COD',
      paymentAmount: d.paymentAmount || 0,
      origin: d.origin || null,
      destination: d.destination || null,
      status: 'assigned',
    })),
    pickupPlan: buildPickupPlan(deliveries),
    notes: notes || '',
    history: [appendHistory('waiting_acceptance', actor, 'Assignment created')],
  });

  // Create with a collision-safe reference (see above).
  let batch = null;
  for (let attempt = 0; attempt < 5 && !batch; attempt += 1) {
    try {
      batch = await batchesRepo.create(batchDoc(await batchesRepo.nextReference()));
    } catch (err) {
      if (err && err.code === 11000 && attempt < 4) continue;
      throw err;
    }
  }

  try {
    await providersService.incrementWorkload(provider._id, batch._id, actor);
  } catch (err) {
    // Capacity exceeded race condition - rollback batch
    await batchesRepo.updateFields(batch._id, { status: 'cancelled' });
    throw err;
  }

  // Persist ownership before lifecycle transitions so emitted events include
  // the provider and batch assignment reference.
  for (const d of deliveries) {
    await deliveriesRepo.updateFields(d._id, { providerId: provider._id, assignmentId: batch._id });
    await transitionDeliveryStatus(d._id, 'assigned', actor, { note: `Assignment ${batch.reference}` }, { deferProviderCompletion: true });
  }

  return batch;
}

async function getBatch(id) {
  const batch = await batchesRepo.findById(id);
  if (!batch) throw Object.assign(new Error('Assignment not found'), { status: 404 });
  return batch;
}

/** Batch + hydrated provider, used by both admin and rider detail views. */
async function getBatchDetail(id) {
  const batch = await getBatch(id);
  const provider = await providersService.getProvider(batch.providerId).catch(() => null);
  return { ...batch.toObject(), provider };
}

async function listBatches(filter = {}, options = {}) {
  const batches = await batchesRepo.findAll(filter, options);
  const total = await batchesRepo.count(filter);
  const limit = options.limit || 50;
  const skip = options.skip || 0;
  return {
    assignments: batches,
    count: batches.length,
    total,
    page: Math.floor(skip / limit) + 1,
    limit,
    totalPages: Math.ceil(total / limit) || 0,
  };
}

/**
 * Reassign a batch to a new rider. The previous batch is kept in history and
 * linked forward; its orders move to the new batch. Never duplicates silently.
 */
async function reassignBatch(id, { providerId, reason, actor }) {
  const previous = await getBatch(id);
  if (!ACTIVE_ASSIGNMENT_BATCH_STATUSES.includes(previous.status)) {
    throw badRequest(`Assignment is ${previous.status} and can no longer be reassigned`);
  }

  // Validate the incoming rider BEFORE mutating anything, so a bad choice
  // (offline, over capacity, wrong area) leaves the current assignment intact.
  const currentDeliveries = [];
  for (const d of previous.deliveries) {
    const delivery = await deliveriesRepo.findById(d.deliveryId);
    if (delivery) currentDeliveries.push(delivery);
  }
  await assertProviderAssignable(providerId, currentDeliveries);

  // The orders are still `assigned` to the outgoing rider, so they would fail
  // the "must be ready" eligibility check. Release them first, then hand them
  // to the new batch — the old assignment itself stays in history below.
  await releaseOrders(previous);

  const next = await createBatch({
    deliveryIds: previous.deliveries.map((d) => String(d.deliveryId)),
    providerId,
    serviceId: previous.serviceId,
    routeId: previous.routeId,
    notes: reason || `Reassigned from ${previous.reference}`,
    actor,
    // The batch being replaced still holds these orders; don't treat it as a conflict.
    skipConflictFor: previous._id,
  });

  await batchesRepo.updateFields(previous._id, {
    status: 'cancelled',
    cancelledAt: new Date(),
    cancellationReason: reason || 'Reassigned',
    reassignedToId: next._id,
    history: [
      ...toPlain(previous.history),
      appendHistory('cancelled', actor, reason || 'Reassigned to another rider'),
    ],
  });
  await batchesRepo.updateFields(next._id, { reassignedFromId: previous._id });

  return { previous: await getBatch(previous._id), assignment: await getBatch(next._id) };
}

/** Rider accepts the assignment. */
async function acceptBatch(id, providerId, actor) {
  const batch = await getBatch(id);
  assertTransition(batch, 'accepted');
  return batchesRepo.updateFields(id, {
    status: 'accepted',
    respondedAt: new Date(),
    history: [
      ...toPlain(batch.history),
      appendHistory('accepted', actor || { id: providerId }, 'Rider accepted the assignment'),
    ],
  });
}

/** Release the batch's orders back to the ready pool. */
async function releaseOrders(batch) {
  try {
    await providersService.decrementWorkload(batch.providerId, batch._id, null);
  } catch (err) {}
  for (const entry of batch.deliveries) {
    // Through the state machine: the release is part of the order's history and
    // Commerce is told the order is back in the delivery pool (an out-of-band
    // field write would leave both in the dark).
    await transitionDeliveryStatus(entry.deliveryId, 'pending', {
      id: String(batch.providerId), name: batch.providerName, role: 'PROVIDER',
    }, { note: `Released from assignment ${batch.reference}` }).catch(() => null);
    await deliveriesRepo.updateFields(entry.deliveryId, {
      status: 'pending', providerId: null, assignmentId: null,
    });
  }
}

/** Rider rejects: releases the orders back to the ready pool. */
async function rejectBatch(id, providerId, reason, actor) {
  const batch = await getBatch(id);
  assertTransition(batch, 'rejected');
  await releaseOrders(batch);
  return batchesRepo.updateFields(id, {
    status: 'rejected',
    respondedAt: new Date(),
    rejectedAt: new Date(),
    rejectionReason: reason || 'Rejected by rider',
    history: [
      ...toPlain(batch.history),
      appendHistory('rejected', actor || { id: providerId }, reason || 'Rejected by rider'),
    ],
  });
}

/** Admin cancellation: releases the orders back to the ready pool. */
async function cancelBatch(id, reason, actor) {
  const batch = await getBatch(id);
  assertTransition(batch, 'cancelled');
  await releaseOrders(batch);
  return batchesRepo.updateFields(id, {
    status: 'cancelled',
    cancelledAt: new Date(),
    cancellationReason: reason || 'Cancelled by admin',
    history: [
      ...toPlain(batch.history),
      appendHistory('cancelled', actor, reason || 'Cancelled by admin'),
    ],
  });
}

/** Rider starts the pickup leg. */
async function startPickup(id, actor) {
  const batch = await getBatch(id);
  assertTransition(batch, 'picking_up');
  return batchesRepo.updateFields(id, {
    status: 'picking_up',
    history: [
      ...toPlain(batch.history),
      appendHistory('picking_up', actor, 'Pickup started'),
    ],
  });
}

/** Confirm pickup for a whole seller stop. */
async function confirmPickupStop(id, sellerId, actor) {
  const batch = await getBatch(id);
  if (batch.status === 'picked_up' && batch.pickupPlan.every((s) => s.completed)) {
    await syncDeliveryStatuses(batch);
    return batch;
  }
  if (batch.status !== 'picking_up') {
    throw badRequest('Pickup can only be confirmed while the rider is picking up');
  }
  const stop = batch.pickupPlan.find((s) => String(s.sellerId) === String(sellerId));
  if (!stop) throw Object.assign(new Error('Pickup stop not found for this seller'), { status: 404 });

  stop.completed = true;
  stop.completedAt = new Date();

  // Mark the orders collected at this stop as picked up.
  for (const orderId of stop.orderIds) {
    const entry = batch.deliveries.find((d) => d.orderId === orderId);
    if (entry) entry.status = 'pickup';
  }

  // The batch is only fully picked up when every seller stop is confirmed.
  const allStopsDone = batch.pickupPlan.every((s) => s.completed);
  const nextStatus = allStopsDone ? 'picked_up' : 'picking_up';
  const history = toPlain(batch.history);
  history.push(appendHistory(nextStatus, actor, `Pickup confirmed at ${stop.shopName || stop.sellerName}`));

  const updated = await batchesRepo.updateFields(id, {
    pickupPlan: batch.pickupPlan,
    deliveries: batch.deliveries,
    status: nextStatus,
    history,
  });
  await syncDeliveryStatuses(updated);
  return updated;
}

/** Rider starts delivering to customers. */
async function startTransit(id, actor) {
  const batch = await getBatch(id);
  if (batch.status === 'in_transit') {
    await syncDeliveryStatuses(batch);
    return batch;
  }
  assertTransition(batch, 'in_transit');
  if (batch.pickupPlan.some((stop) => !stop.completed)) {
    throw badRequest('Confirm every seller pickup before starting delivery');
  }
  for (const entry of batch.deliveries) {
    if (entry.status === 'pickup') entry.status = 'in_transit';
  }
  const updated = await batchesRepo.updateFields(id, {
    status: 'in_transit',
    deliveries: batch.deliveries,
    history: [
      ...toPlain(batch.history),
      appendHistory('in_transit', actor, 'Started delivery'),
    ],
  });
  await syncDeliveryStatuses(updated);
  return updated;
}

/**
 * Mark one order delivered. The assignment only completes when EVERY order in
 * it is actually delivered — never earlier.
 */
async function markDelivered(id, orderId, actor, proof = {}) {
  const batch = await getBatch(id);
  if (batch.status !== 'in_transit') {
    throw badRequest('Orders can only be delivered while the assignment is in transit');
  }
  const entry = batch.deliveries.find((d) => d.orderId === orderId);
  if (!entry) throw Object.assign(new Error('Order is not part of this assignment'), { status: 404 });
  const proofOfDelivery = extractProofOfDelivery(proof);
  if (entry.status === 'delivered') {
    const delivery = await deliveriesRepo.findById(entry.deliveryId);
    await transitionDeliveryStatus(entry.deliveryId, 'delivered', actor, {
      ...proof,
      proofOfDelivery: proofOfDelivery || delivery?.proofOfDelivery || null,
      note: `Delivered via assignment ${batch.reference}`,
    }, { deferProviderCompletion: true });
    return batch;
  }

  entry.status = 'delivered';
  await transitionDeliveryStatus(entry.deliveryId, 'delivered', actor, {
    ...proof,
    proofOfDelivery,
    note: `Delivered via assignment ${batch.reference}`,
  }, { deferProviderCompletion: true });

  const allDelivered = batch.deliveries.every((d) => d.status === 'delivered');
  if (allDelivered) {
    try {
      await providersService.completeDelivery(batch.providerId, batch._id, actor);
    } catch (err) {}
  }
  const history = toPlain(batch.history);
  history.push(appendHistory(allDelivered ? 'completed' : 'in_transit', actor, `Order ${orderId} delivered`));

  return batchesRepo.updateFields(id, {
    deliveries: batch.deliveries,
    status: allDelivered ? 'completed' : 'in_transit',
    completedAt: allDelivered ? new Date() : batch.completedAt,
    history,
  });
}

/** All batches held by one rider, newest first (rider portal home). */
async function listBatchesForProvider(providerId, options = {}) {
  return listBatches({ providerId }, options);
}

/**
 * Resolve the Provider behind an authenticated actor.
 *
 * The identity layer hands us a user id, but assignments reference the Provider
 * document, so accept a match on either `identityUserId` or the Provider `_id`.
 */
async function resolveProvider(actorId) {
  if (!actorId) return null;
  const byIdentity = await providersRepo.findByIdentityUserId(String(actorId)).catch(() => null);
  if (byIdentity) return byIdentity;
  if (mongoose.isValidObjectId(String(actorId))) {
    return providersService.getProvider(actorId).catch(() => null);
  }
  return null;
}

/** Load a batch and prove the authenticated actor is its rider. */
async function getBatchForRider(id, actorId) {
  const batch = await getBatch(id);
  const provider = await resolveProvider(actorId);
  if (!provider || String(batch.providerId) !== String(provider._id)) {
    throw Object.assign(new Error('Not authorized for this assignment'), { status: 403 });
  }
  return { batch, provider };
}

module.exports = {
  createBatch, getBatch, getBatchDetail, listBatches, reassignBatch,
  acceptBatch, rejectBatch, cancelBatch,
  startPickup, confirmPickupStop, startTransit, markDelivered,
  assertProviderAssignable, buildPickupPlan,
  listBatchesForProvider, resolveProvider, getBatchForRider,
};
