const svc = require('../services/delivery-request.service');
const deliveriesRepo = require('../repositories/delivery.repository');
const { ok, created } = require('../../../shared/utils/response');
const { forbidden } = require('../../../shared/errors');
const { isAdmin, isSeller, isBuyer, assertCanReadRequest } = require('../../../shared/utils/access');

async function createRequest(req, res, next) {
  try { return created(res, { request: await svc.createRequest(req.body) }, 'Delivery request created'); }
  catch (err) { return next(err); }
}

async function getRequest(req, res, next) {
  try {
    const request = await svc.getRequest(req.params.id);
    await assertCanReadRequest(request, req.user);
    return ok(res, { request });
  } catch (err) { return next(err); }
}

/**
 * Commerce → Delivery handoff list.
 *
 * Scoping: admins see everything, sellers/buyers only their own — the query
 * params can narrow but never widen that boundary.
 *
 * Response carries real pagination (total/page/limit/totalPages) plus the
 * materialization state, derived from whether a Delivery exists for the
 * order: `pending` → handed over, `materialized` → a Delivery exists and the
 * admin can follow the link.
 */
async function getRequests(req, res, next) {
  try {
    const {
      sellerId, buyerId, orderId, search, zoneId, serviceId,
      dateFrom, dateTo, page = 1, limit = 50,
    } = req.query;

    const filter = {};
    if (req.user && !isAdmin(req.user)) {
      if (isSeller(req.user)) filter.sellerId = req.user.id;
      else if (isBuyer(req.user)) filter.buyerId = req.user.id;
      else return next(forbidden('Delivery requests are visible to admins, sellers and buyers only'));
    }

    if (sellerId && !filter.sellerId) filter.sellerId = sellerId;
    if (buyerId && !filter.buyerId) filter.buyerId = buyerId;
    if (orderId) filter.orderId = orderId;
    if (zoneId) filter['deliveryAddress.zoneId'] = zoneId;
    if (serviceId) filter.preferredServiceId = serviceId;
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { orderId: rx },
        { 'deliveryAddress.cityName': rx },
        { 'deliveryAddress.sectorName': rx },
        { 'deliveryAddress.addressDetail': rx },
        { 'pickupAddress.shopName': rx },
        { 'pickupAddress.businessId': rx },
      ];
    }

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;

    const [requests, total] = await Promise.all([
      svc.getRequests(filter, { skip, limit: safeLimit }),
      svc.countRequests(filter),
    ]);

    // One query resolves the Delivery for the whole page — status + link.
    const orderIds = requests.map((r) => r.orderId).filter(Boolean);
    const deliveries = orderIds.length ? await deliveriesRepo.findByOrderIds(orderIds) : [];
    const byOrder = new Map(deliveries.map((d) => [String(d.orderId), d]));

    const items = requests.map((r) => {
      const delivery = byOrder.get(String(r.orderId));
      return {
        ...(r.toObject ? r.toObject() : r),
        // The console reads `id` on every row; `_id` alone crashed its table.
        id: String(r._id),
        status: delivery ? 'materialized' : 'pending',
        deliveryId: delivery ? delivery._id : null,
        deliveryStatus: delivery ? delivery.status : null,
      };
    });

    return ok(res, {
      requests: items,
      count: items.length,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { return next(err); }
}

async function validateAddress(req, res, next) {
  try { return ok(res, await svc.validateAddress(req.body)); }
  catch (err) { return next(err); }
}

module.exports = { createRequest, getRequest, getRequests, validateAddress };
