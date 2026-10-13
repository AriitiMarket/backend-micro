/**
 * Orders the admin may select for assignment right now.
 *
 * An order is "ready" only when its delivery is still in the ready pool
 * (`READY_DELIVERY_STATUSES`) AND it is not already held by an active
 * assignment. The list is enriched with the display fields the admin table
 * needs (seller, pickup, customer, zone) so the screen needs no extra joins.
 */
const batchesRepo = require('../repositories/assignmentBatches.repository');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const zonesService = require('../../locations-expansion/services/zones.service');
const { READY_DELIVERY_STATUSES } = require('../../../shared/constants');

async function listReadyOrders({ search, zoneId, sellerId, page = 1, limit = 20 } = {}) {
  const filter = { status: { $in: READY_DELIVERY_STATUSES }, shipmentId: null };
  if (zoneId) filter['destination.zoneId'] = zoneId;
  if (sellerId) filter.sellerId = sellerId;
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { orderId: rx },
      { 'origin.shopName': rx },
      { 'destination.addressDetail': rx },
    ];
  }

  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const skip = (safePage - 1) * safeLimit;

  const [all, total] = await Promise.all([
    deliveriesRepo.findAll(filter, { skip, limit: safeLimit }),
    deliveriesRepo.count(filter),
  ]);

  // Exclude anything already held by an active assignment, then resolve the
  // zone names the table shows.
  const ids = all.map((d) => d._id);
  const active = ids.length ? await batchesRepo.findActiveByDeliveryIds(ids) : [];
  const blocked = new Set(
    active.flatMap((b) => b.deliveries.map((d) => String(d.deliveryId))),
  );
  const visible = all.filter((d) => !blocked.has(String(d._id)));

  const zoneIds = [...new Set(visible.map((d) => d.destination && d.destination.zoneId).filter(Boolean).map(String))];
  const zoneNames = new Map();
  if (zoneIds.length > 0) {
    const zones = await zonesService.getZones({ _id: { $in: zoneIds } }).catch(() => []);
    zones.forEach((z) => zoneNames.set(String(z._id), z.name));
  }

  const orders = visible.map((d) => ({
    id: String(d._id),
    orderId: d.orderId,
    sellerId: d.sellerId,
    sellerName: (d.origin && d.origin.shopName) || d.sellerId,
    shopName: (d.origin && d.origin.shopName) || '',
    pickup: [
      d.origin && d.origin.cityName,
    ].filter(Boolean).join(', ') || '—',
    customer: [
      d.destination && d.destination.addressDetail,
    ].filter(Boolean).join(', ') || '—',
    zoneId: (d.destination && d.destination.zoneId) || null,
    zoneName: (d.destination && d.destination.zoneId)
      ? zoneNames.get(String(d.destination.zoneId)) || '—'
      : '—',
    status: d.status,
    createdAt: d.createdAt,
  }));

  return {
    orders,
    count: orders.length,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 0,
  };
}

module.exports = { listReadyOrders };
