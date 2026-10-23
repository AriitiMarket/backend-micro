const svc = require('../services/assignmentBatches.service');
const readyOrdersSvc = require('../services/readyOrders.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { forbidden } = require('../../../shared/errors');
const { isAdmin } = require('../../../shared/utils/access');

/** Orders eligible for assignment right now (Ready for Delivery table). */
async function listReadyOrders(req, res, next) {
  try {
    const { search, zoneId, sellerId, page, limit } = req.query;
    return ok(res, await readyOrdersSvc.listReadyOrders({ search, zoneId, sellerId, page, limit }));
  } catch (err) { return next(err); }
}

/** Batch-assign many ready orders to one rider. */
async function createBatchAssignment(req, res, next) {
  try {
    const { deliveryIds, serviceId, routeId, notes } = req.body;
    // `partnerId` is the legacy spelling — still sent by the deployed admin
    // console's assign-rider panel.
    const providerId = req.body.providerId || req.body.partnerId;
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    const assignment = await svc.createBatch({
      deliveryIds,
      providerId,
      serviceId,
      routeId,
      notes,
      actor: { id: adminId, name: adminName },
    });
    sendAudit({
      action: 'ASSIGNMENT_BATCH_CREATED', adminId, adminName,
      targetEntity: 'assignmentBatch', targetId: String(assignment._id),
      newValue: { providerId, orderCount: assignment.deliveries.length }, ipAddress,
    });
    return created(res, { assignment }, 'Assignment created');
  } catch (err) { return next(err); }
}

/**
 * One batch. ADMIN sees any; a delivery provider only the batch assigned to their
 * own Provider record — the same ownership proof the rider actions use, so the
 * detail screen can never show (or act on) another provider's work.
 */
async function getBatchAssignment(req, res, next) {
  try {
    const batch = await svc.getBatchDetail(req.params.id);
    if (!isAdmin(req.user)) {
      const provider = await svc.resolveProvider(req.user && req.user.id);
      if (!provider || String(batch.providerId) !== String(provider._id)) {
        return next(forbidden('You can only open your own assignments'));
      }
    }
    return ok(res, { assignment: batch });
  } catch (err) { return next(err); }
}

async function listBatchAssignments(req, res, next) {
  try {
    const { status, providerId, search, page = 1, limit = 50 } = req.query;
    // Legacy spelling of the same filter, still sent by deployed clients.
    const requestedProviderId = providerId || req.query.partnerId;
    const filter = {};
    if (status) filter.status = status;
    if (requestedProviderId) filter.providerId = requestedProviderId;
    if (search) filter.reference = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const result = await svc.listBatches(filter, { skip: (safePage - 1) * safeLimit, limit: safeLimit });
    return ok(res, result);
  } catch (err) { return next(err); }
}

/** Reassign: previous assignment is preserved in history and linked forward. */
async function reassignBatchAssignment(req, res, next) {
  try {
    const { reason } = req.body;
    // `partnerId` is the legacy spelling of the body field — accepted so an
    // already-deployed console keeps reassigning batches.
    const providerId = req.body.providerId || req.body.partnerId;
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    const result = await svc.reassignBatch(req.params.id, {
      providerId, reason, actor: { id: adminId, name: adminName },
    });
    sendAudit({
      action: 'ASSIGNMENT_BATCH_REASSIGNED', adminId, adminName,
      targetEntity: 'assignmentBatch', targetId: req.params.id,
      newValue: { providerId }, ipAddress,
    });
    return ok(res, result, 'Reassigned');
  } catch (err) { return next(err); }
}

async function cancelBatchAssignment(req, res, next) {
  try {
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    const result = await svc.cancelBatch(req.params.id, req.body.reason, { id: adminId, name: adminName });
    sendAudit({
      action: 'ASSIGNMENT_BATCH_CANCELLED', adminId, adminName,
      targetEntity: 'assignmentBatch', targetId: req.params.id, ipAddress,
    });
    return ok(res, { assignment: result }, 'Assignment cancelled');
  } catch (err) { return next(err); }
}

/** Current rider's assignments (rider portal home list). */
async function listMyAssignments(req, res, next) {
  try {
    const provider = await svc.resolveProvider(req.user && req.user.id);
    if (!provider) return ok(res, { assignments: [], count: 0, total: 0, page: 1, limit: 50, totalPages: 0 });
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const result = await svc.listBatchesForProvider(provider._id, { skip: (page - 1) * limit, limit });
    return ok(res, result);
  } catch (err) { return next(err); }
}

/** Accept / reject the rider's own assignment. */
async function respondToBatch(req, res, next) {
  try {
    const accepted = Boolean(req.body.accepted);
    const { batch, provider } = await svc.getBatchForRider(req.params.id, req.user && req.user.id);
    const actor = { id: String(provider._id), name: provider.name, role: 'PROVIDER' };
    const result = accepted
      ? await svc.acceptBatch(batch._id, provider._id, actor)
      : await svc.rejectBatch(batch._id, provider._id, req.body.reason, actor);
    return ok(res, { assignment: result }, accepted ? 'Assignment accepted' : 'Assignment rejected');
  } catch (err) { return next(err); }
}

/** Rider starts the pickup leg. */
async function startPickup(req, res, next) {
  try {
    const { batch, provider } = await svc.getBatchForRider(req.params.id, req.user && req.user.id);
    const result = await svc.startPickup(batch._id, { id: String(provider._id), name: provider.name, role: 'PROVIDER' });
    return ok(res, { assignment: result }, 'Pickup started');
  } catch (err) { return next(err); }
}

/** Rider confirms they collected the orders for one seller stop. */
async function confirmPickup(req, res, next) {
  try {
    const { batch, provider } = await svc.getBatchForRider(req.params.id, req.user && req.user.id);
    const result = await svc.confirmPickupStop(
      batch._id,
      req.params.sellerId,
      { id: String(provider._id), name: provider.name, role: 'PROVIDER' },
      req.body
    );
    return ok(res, { assignment: result }, 'Pickup confirmed');
  } catch (err) { return next(err); }
}

/** Rider starts delivering to customers. */
async function startTransit(req, res, next) {
  try {
    const { batch, provider } = await svc.getBatchForRider(req.params.id, req.user && req.user.id);
    const result = await svc.startTransit(batch._id, { id: String(provider._id), name: provider.name, role: 'PROVIDER' });
    return ok(res, { assignment: result }, 'Delivery started');
  } catch (err) { return next(err); }
}

/** Rider confirms delivery of a single order (with proof when the rules need it). */
async function confirmDelivery(req, res, next) {
  try {
    const { batch, provider } = await svc.getBatchForRider(req.params.id, req.user && req.user.id);
    const actor = { id: String(provider._id), name: provider.name, role: 'PROVIDER' };
    const result = await svc.markDelivered(batch._id, req.params.orderId, actor, req.body || {});
    return ok(res, { assignment: result }, 'Order delivered');
  } catch (err) { return next(err); }
}

/** Rider confirms delivery of ALL remaining orders in a batch with one click. */
async function deliverAllBatchOrders(req, res, next) {
  try {
    const { batch, provider } = await svc.getBatchForRider(req.params.id, req.user && req.user.id);
    const actor = { id: String(provider._id), name: provider.name, role: 'PROVIDER' };

    const ordersToDeliver = batch.deliveries.filter((d) => d.status !== 'delivered');
    if (ordersToDeliver.length === 0) {
      return ok(res, { message: 'No active orders to deliver', total: 0, delivered: 0 }, 'No orders to deliver');
    }

    // Mark each remaining order as delivered
    const results = [];
    for (const entry of ordersToDeliver) {
      const result = await svc.markDelivered(batch._id, entry.orderId, actor, {});
      results.push({ orderId: entry.orderId, success: true });
    }

    // Sync delivery statuses to update provider workload etc.
    await svc.syncDeliveryStatuses(batch);

    return ok(res, { results, total: ordersToDeliver.length }, 'All batch orders delivered');
  } catch (err) { return next(err); }
}

module.exports = {
  listReadyOrders, createBatchAssignment, getBatchAssignment,
  listBatchAssignments, reassignBatchAssignment, cancelBatchAssignment,
  listMyAssignments, respondToBatch, startPickup, confirmPickup,
  startTransit, confirmDelivery, deliverAllBatchOrders,
};
