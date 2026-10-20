const svc = require('../services/delivery-fulfillment.service');
const providersService = require('../../providers/services/providers.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const {
  isAdmin, isSeller, isOperator, isBuyer, resolveProviderForUser, assertCanReadDelivery,
} = require('../../../shared/utils/access');
const assignmentsService = require('../../operations/services/assignments.service');
const validators = require('../validators');

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

// ── Role-scoped serialization ────────────────────────────────────────────────
// A buyer or a seller sees the delivery of their own order — not the provider's
// private record (linked identity account, phone, e-mail, live location), not
// the internal assignment log and not the operational metadata. Admins keep the
// full operational view.
const BUYER_VISIBLE_PROVIDER_FIELDS = ['_id', 'name', 'providerType', 'vehicleType'];
const SELLER_VISIBLE_PROVIDER_FIELDS = [...BUYER_VISIBLE_PROVIDER_FIELDS, 'plateNumber'];

function publicProvider(provider, fields) {
  if (!provider) return null;
  const doc = provider.toObject ? provider.toObject() : provider;
  const out = {};
  for (const field of fields) if (doc[field] !== undefined) out[field] = doc[field];
  return out;
}

/** Fields an operational viewer (admin) may see; everyone else is projected. */
function serializeForActor(delivery, user) {
  const obj = withAddressAliases(delivery);
  if (!obj || isAdmin(user)) return obj;
  const providerFields = isSeller(user) ? SELLER_VISIBLE_PROVIDER_FIELDS : BUYER_VISIBLE_PROVIDER_FIELDS;
  return {
    ...obj,
    provider: publicProvider(obj.provider, providerFields),
    // Internal operational artefacts: the assignment offers and their notes, plus
    // the service's own bookkeeping, stay with the operators who act on them.
    assignmentHistory: undefined,
    metadata: undefined,
  };
}

async function getDelivery(req, res, next) {
  try {
    const detail = await svc.getDeliveryDetail(req.params.id);
    await assertCanReadDelivery(detail, req.user);
    return ok(res, { delivery: serializeForActor(detail, req.user) });
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
    const found = await svc.getDeliveryByOrderId(req.params.orderId);
    if (!found) return ok(res, { delivery: null });
    // Same enriched shape as the id-based read: the order-scoped lookup is the
    // natural one for a buyer or seller following their own order, so it must
    // carry the provider, timeline and tracking history too (it used to return
    // the raw document, so `provider` was always null even after assignment).
    const detail = await svc.getDeliveryDetail(found._id);
    await assertCanReadDelivery(detail, req.user);
    return ok(res, { delivery: serializeForActor(detail, req.user) });
  } catch (err) { return next(err); }
}

async function updateStatus(req, res, next) {
  try {
    // The status is normalized at the boundary (any accepted spelling — the
    // canonical name, the persisted value or a historical alias), so a caller
    // cannot reach the state machine with a value it would misread as an
    // invalid transition.
    const payload = validators.validateStatusPayload(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    const result = await svc.updateStatus(req.params.id, payload.status, payload, {
      id: adminId,
      name: adminName,
      role: req.user ? req.user.role : null,
    });
    sendAudit({ action: 'DELIVERY_STATUS_CHANGED', adminId, adminName, targetEntity: 'delivery', targetId: req.params.id, newValue: { status: payload.status }, ipAddress });
    return ok(res, { delivery: result }, 'Delivery status updated');
  } catch (err) { return next(err); }
}

async function assignDelivery(req, res, next) {
  try {
    // `partnerId` is the legacy spelling of the body field (deployed clients
    // still send it); `actorId` is the oldest spelling of the same input.
    const providerId = req.body.providerId || req.body.partnerId || req.body.actorId;
    if (!providerId) throw Object.assign(new Error('providerId is required'), { status: 400 });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    const assignment = await assignmentsService.createAssignment({
      deliveryId: req.params.id,
      providerId,
      zoneId: req.body.zoneId,
      serviceId: req.body.serviceId,
      notes: req.body.notes,
      actorId: adminId,
      actorName: adminName,
      actorRole: req.user ? req.user.role : 'ADMIN',
    });
    sendAudit({ action: 'DELIVERY_ASSIGNED', adminId, adminName, targetEntity: 'delivery', targetId: req.params.id, newValue: { providerId }, ipAddress });
    return ok(res, { assignment }, 'Delivery assigned');
  } catch (err) { return next(err); }
}

/**
 * Tenant scoping + operational filters for the delivery list.
 *
 * Roles arrive UPPERCASE from the gateway, and a delivery provider's identity id
 * is NOT the Provider _id stored on a delivery — resolve it first. Non-admin
 * users can only narrow further; query params never widen the boundary.
 */
async function buildDeliveryFilter(query, user) {
  const { serviceId, dateFrom, dateTo, sellerId, buyerId, providerId } = query;
  // Legacy spelling of the provider filter — accepted so an already-deployed
  // client keeps narrowing the list correctly.
  const requestedProviderId = providerId || query.partnerId;

  // One query validator for the whole service: it normalizes every accepted
  // status spelling, rejects an unknown one with `UNKNOWN_STATUS` (instead of
  // silently returning an empty page) and bounds the pagination. Tenant scoping
  // is then applied on top and can only NARROW the filter — a query parameter
  // never widens it.
  const { filter, page: safePage, limit: safeLimit } = validators.buildDeliveryFilter({
    ...query,
    providerId: requestedProviderId,
    sellerId: undefined,
    buyerId: undefined,
  });

  if (user) {
    if (isAdmin(user)) {
      // Operational access — the filters below apply as requested.
    } else if (isSeller(user)) {
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

  // Query params may narrow the tenant's own view, never widen it.
  if (sellerId && !filter.sellerId) filter.sellerId = sellerId;
  if (buyerId && !filter.buyerId) filter.buyerId = buyerId;
  if (requestedProviderId && !filter.providerId) filter.providerId = requestedProviderId;
  if (serviceId) filter.serviceId = serviceId;
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }
  // Completion metrics use the delivery's last transition timestamp, not its
  // creation date. These filters are only meaningful for delivered records.
  const { completedFrom, completedTo } = query;
  if ((completedFrom || completedTo) && filter.status === 'delivered') {
    filter.updatedAt = {};
    if (completedFrom) filter.updatedAt.$gte = new Date(completedFrom);
    if (completedTo) filter.updatedAt.$lte = new Date(completedTo);
  }

  return { filter, page: safePage, limit: safeLimit };
}

async function getDeliveries(req, res, next) {
  try {
    const { filter, page, limit } = await buildDeliveryFilter(req.query, req.user);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [deliveries, total] = await Promise.all([svc.getDeliveries(filter, { skip, limit: safeLimit }), svc.countDeliveries(filter)]);
    return ok(res, {
      deliveries: deliveries.map((delivery) => serializeForActor(delivery, req.user)),
      count: deliveries.length, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { return next(err); }
}

module.exports = { createDelivery, getDelivery, getDeliveryHistory, getDeliveryByOrderId, updateStatus, assignDelivery, getDeliveries };
