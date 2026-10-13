const shipmentsService = require('../services/shipments.service');
const consolidationService = require('../services/consolidation.service');
const { ok, created } = require('../../../shared/utils/response');
const { getAdminFromReq } = require('../../../shared/utils/audit-client');

/** The audit helper speaks `adminId/adminName`; services expect `id/name`. */
function actorFrom(req) {
  const g = getAdminFromReq(req);
  return { id: g.adminId ?? null, name: g.adminName ?? null };
}

async function getCandidates(req, res, next) {
  try {
    const filter = {
      originLocationId: req.query.originLocationId,
      destinationLocationId: req.query.destinationLocationId,
      serviceId: req.query.serviceId
    };
    const candidates = await consolidationService.getCandidates(filter);
    return ok(res, { candidates });
  } catch (err) { next(err); }
}

async function createConsolidation(req, res, next) {
  try {
    const actor = actorFrom(req);
    // `partnerId` is the legacy spelling of the provider field on the body.
    const data = { ...req.body, providerId: req.body.providerId || req.body.partnerId };
    const shipment = await consolidationService.confirmConsolidation(data, actor);
    return created(res, { shipment }, 'Shipment created via consolidation');
  } catch (err) { next(err); }
}

async function getShipment(req, res, next) {
  try {
    const shipment = await shipmentsService.getShipment(req.params.id);
    return ok(res, { shipment });
  } catch (err) { next(err); }
}

async function getShipments(req, res, next) {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (req.query.shipmentNumber) filter.shipmentNumber = req.query.shipmentNumber;
    if (req.query.routeId) filter.routeId = req.query.routeId;
    if (req.query.originLocationId) filter.originLocationId = req.query.originLocationId;
    if (req.query.destinationLocationId) filter.destinationLocationId = req.query.destinationLocationId;
    if (req.query.portId) filter.$or = [{ originPortId: req.query.portId }, { destinationPortId: req.query.portId }];
    if (req.query.serviceId) filter.serviceId = req.query.serviceId;
    // `partnerId` is the legacy spelling of this filter — accepted so an
    // already-deployed client keeps narrowing the shipment list correctly.
    const providerFilter = req.query.providerId || req.query.partnerId;
    if (providerFilter) filter.providerId = providerFilter;
    if (req.query.orderId) filter['items.orderId'] = req.query.orderId;
    if (req.query.deliveryId) filter['items.deliveryId'] = req.query.deliveryId;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.createdAt.$lte = new Date(req.query.dateTo);
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;

    const [shipments, total] = await Promise.all([
      shipmentsService.getShipments(filter, { skip, limit: safeLimit }),
      shipmentsService.countShipments(filter),
    ]);
    return ok(res, {
      shipments,
      count: shipments.length,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { next(err); }
}

async function transitionStatus(req, res, next) {
  try {
    const actor = actorFrom(req);
    const { action } = req.params; // consolidate, dispatch, arrive, receive
    const allowedActions = {
      'dispatch': 'dispatched',
      'arrive': 'arrived',
      'receive': 'received'
    };
    
    const targetStatus = allowedActions[action];
    if (!targetStatus) return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'Invalid action', errors: [] });

    const shipment = await shipmentsService.transitionShipmentStatus(req.params.id, targetStatus, actor, req.body.note);
    
    // If received, we need to release deliveries for last-mile assignment
    // (This is conceptually un-assigning them from line-haul and making them available in destination port)
    // Actually they stay with shipmentId but their fulfillment status can remain unchanged, or changed to 'port_received' if needed. 
    // The prompt says: "Do not automatically mark every delivery as delivered because a shipment arrived at a port."
    // and "Shipment received -> Deliveries become available for next operational stage".
    // Since AssignmentBatch pulls from deliveries based on their status, we don't need to change Delivery status here unless required.

    return ok(res, { shipment }, `Shipment ${action} successful`);
  } catch (err) { next(err); }
}

module.exports = {
  getCandidates,
  createConsolidation,
  getShipment,
  getShipments,
  transitionStatus
};
