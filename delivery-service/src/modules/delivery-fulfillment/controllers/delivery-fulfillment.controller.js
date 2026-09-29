const svc = require('../services/delivery-fulfillment.service');
const providersService = require('../../providers/services/providers.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const {
  isAdmin, isOperator, isBuyer, resolveProviderForUser, assertCanReadDelivery,
} = require('../../../shared/utils/access');
const assignmentsService = require('../../operations/services/assignments.service');

async function createDelivery(req, res, next) {
  try {
    const result = await svc.createDelivery(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'DELIVERY_CREATED', adminId, adminName, targetEntity: 'delivery', targetId: result._id, ipAddress });
    return created(res, { delivery: result }, 'Delivery created');
  } catch (err) { return next(err); }
}

function withAddressAliases(delivery) {
  const obj = delivery && delivery.toObject ? delivery.toObject() : delivery;
  if (!obj) return obj;
  return {
    ...obj,
    pickupAddress: obj.origin || obj.pickupAddress || null,
    destinationAddress: obj.destination || obj.destinationAddress || null,
    deliveryAddress: obj.destination || obj.deliveryAddress || null,
    providerName: obj.provider && obj.provider.name ? obj.provider.name : obj.providerName,
  };
}

async function getDelivery(req, res, next) {
  try {
    const detail = await svc.getDeliveryDetail(req.params.id);
    await assertCanReadDelivery(detail, req.user);
    return ok(res, { delivery: withAddressAliases(detail) });
  } catch (err) { return next(err); }
}

async function getDeliveryHistory(req, res, next) {
  try {
    const delivery = await svc.getDelivery(req.params.id);
    await assertCanReadDelivery(delivery, req.user);
    return ok(res, await svc.getDeliveryHistory(req.params.id));
  } catch (err) { return next(err); }
}

async function getDeliveryByOrderId(req, res, next) {
  try {
    const delivery = await svc.getDeliveryByOrderId(req.params.orderId);
    if (delivery) await assertCanReadDelivery(delivery, req.user);
    return ok(res, { delivery: delivery ? withAddressAliases(delivery) : null });
  } catch (err) { return next(err); }
}

async function updateStatus(req, res, next) {
  try {
    const result = await svc.updateStatus(req.params.id, req.body.status, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'DELIVERY_STATUS_CHANGED', adminId, adminName, targetEntity: 'delivery', targetId: req.params.id, newValue: { status: req.body.status }, ipAddress });
    return ok(res, { delivery: result }, 'Delivery status updated');
  } catch (err) { return next(err); }
}

async function assignDelivery(req, res, next) {
  try {
    // `partnerId` is the legacy spelling of the body field (deployed clients
    // still send it); `actorId` is the oldest spelling of the same input.
    const providerId = req.body.providerId || req.body.partnerId || req.body.actorId;
    if (!providerId) throw Object.assign(new Error('providerId is required'), { status: 400 });
    const assignment = await assignmentsService.createAssignment({
      deliveryId: req.params.id,
      providerId,
      zoneId: req.body.zoneId,
      serviceId: req.body.serviceId,
      notes: req.body.notes,
    });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'DELIVERY_ASSIGNED', adminId, adminName, targetEntity: 'delivery', targetId: req.params.id, newValue: { providerId }, ipAddress });
    return ok(res, { assignment }, 'Delivery assigned');
  } catch (err) { return next(err); }
}

/**
 * Tenant scoping + operational filters for the delivery list.
 *
 * Roles arrive UPPERCASE from the gateway, and a rider's identity id is NOT
 * the Provider _id stored on a delivery — resolve it first. Non-admin users
 * can only narrow further; query params never widen the boundary.
 */
async function buildDeliveryFilter(query, user) {
  const {
    status, sellerId, buyerId, providerId, sectorId, zoneId, orderId, serviceId,
    search, dateFrom, dateTo, page = 1, limit = 50,
  } = query;
  // Legacy spelling of the provider filter — accepted so an already-deployed
  // client keeps narrowing the list correctly.
  const requestedProviderId = providerId || query.partnerId;
  const filter = {};

  if (user) {
    if (isAdmin(user)) {
      // Operational access — query filters below apply as requested.
    } else if (user.role === 'SELLER') {
      filter.sellerId = user.id;
    } else if (isBuyer(user)) {
      filter.buyerId = user.id;
    } else if (isOperator(user)) {
      const provider = await resolveProviderForUser(user);
      // An operator without a Provider document sees nothing: `null` matches
      // deliveries whose providerId is unset. The previous '__no_partner__'
      // sentinel could not be cast to an ObjectId and turned the list into a
      // 400 CastError.
      filter.providerId = provider ? String(provider._id) : null;
    } else {
      filter.providerId = null;
    }
  }

  if (status) filter.status = status;
  if (sellerId && !filter.sellerId) filter.sellerId = sellerId;
  if (buyerId && !filter.buyerId) filter.buyerId = buyerId;
  if (requestedProviderId && !filter.providerId) filter.providerId = requestedProviderId;
  if (sectorId) filter['destination.sectorId'] = sectorId;
  if (zoneId) filter['destination.zoneId'] = zoneId;
  if (orderId) filter.orderId = orderId;
  if (serviceId) filter.serviceId = serviceId;
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ orderId: rx }, { 'destination.sectorName': rx }, { 'destination.addressDetail': rx }, { 'destination.cityName': rx }];
  }
  return { filter, page, limit };
}

async function getDeliveries(req, res, next) {
  try {
    const { filter, page, limit } = await buildDeliveryFilter(req.query, req.user);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [deliveries, total] = await Promise.all([svc.getDeliveries(filter, { skip, limit: safeLimit }), svc.countDeliveries(filter)]);
    return ok(res, { deliveries: deliveries.map(withAddressAliases), count: deliveries.length, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 });
  } catch (err) { return next(err); }
}

module.exports = { createDelivery, getDelivery, getDeliveryHistory, getDeliveryByOrderId, updateStatus, assignDelivery, getDeliveries };
