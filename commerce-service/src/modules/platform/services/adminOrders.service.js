/**
 * Admin Orders Service
 *
 * Handles order lifecycle mapping, operational stages, and cross-service delivery
 * aggregation for the Admin Platform Control Center.
 */
const orderRepo = require('../../orders/repositories/orders.repository');
const shopRepo = require('../../selling/repositories/shops.repository');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const { identityClient } = require('../../../app/clients/identity.client');
const adminHierarchyService = require('./adminHierarchy.service');
const adminBusinessesService = require('./adminBusinesses.service');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const lifecycle = require('../../orders/services/orderState.service');
const {
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
  normalizeStatus,
} = require('../../orders/constants/orderStatuses');

const STAGE_SCAN_LIMIT = 5000;
const STAGE_SCAN_BATCH = 500;

function sumStatuses(countFor, statuses) {
  let total = 0;
  for (const status of statuses) {
    const value = countFor(status);
    if (value === null) return null;
    total += value;
  }
  return total;
}

async function safe(label, promise) {
  try {
    return { ok: true, data: await promise };
  } catch (err) {
    return { ok: false, data: null, error: `${label}: ${err.message}` };
  }
}

function paginate(page, limit, defaults = { page: 1, limit: 50, maxLimit: 200 }) {
  const safePage = Math.max(parseInt(page, 10) || defaults.page, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || defaults.limit, 1), defaults.maxLimit);
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class AdminOrdersService {
  /**
   * One order row in the admin vocabulary. Commerce owns the order fields,
   * Delivery supplies the physical movement, and the lifecycle mapper names the
   * stage — nothing here is invented.
   */
  toOrderRow(order, delivery) {
    const mapped = lifecycle.mapOrderToOperationalStage(order, delivery);
    return {
      id: String(order._id),
      buyerId: order.buyerId || null,
      customerRef: order.buyerId ? `#${String(order.buyerId).slice(-6)}` : null,
      user: order.user
        ? { name: order.user.name || null, email: order.user.email || null }
        : null,
      sellerId: order.sellerId || null,
      totalPrice: order.totalPrice,
      items: Array.isArray(order.cart) ? order.cart.length : 0,
      status: order.status,
      paymentStatus: order.paymentStatus,
      stage: mapped.stage,
      stageLabel: lifecycle.stageLabel(mapped.stage),
      stageReason: mapped.reason,
      stageSource: mapped.source,
      deliveryStatus: delivery ? delivery.status : null,
      deliveryId: delivery ? String(delivery._id) : null,
      pickupLocationId: delivery ? delivery.pickupLocationId : null,
      destinationLocationId: delivery ? delivery.destinationLocationId : null,
      destination: order.destination || null,
      sellerShipments: (order.sellerShipments || []).map(s => ({
        sellerId: s.sellerId,
        shopId: s.shopId,
        businessId: s.businessId || null,
        origin: s.origin || null,
        subtotal: s.subtotal || 0,
        itemCount: Array.isArray(s.items) ? s.items.length : 0,
      })),
      shippingAddress: order.shippingAddress || null,
      pickedUpAt: delivery ? delivery.pickedUpAt : null,
      deliveredAt: order.deliveredAt || (delivery ? delivery.deliveredAt : null),
      failureReason: delivery ? delivery.failureReason : null,
      createdAt: order.createdAt,
    };
  }

  /**
   * Reads a scoped order query in batches.
   *
   * Required for the operational stage, which is DERIVED (order status +
   * delivery status) and therefore cannot be expressed as a database filter.
   */
  async collectScopedOrders(query, cap = STAGE_SCAN_LIMIT) {
    const rows = [];
    while (rows.length < cap) {
      const chunk = await orderRepo.findAll(query, {
        skip: rows.length,
        limit: Math.min(STAGE_SCAN_BATCH, cap - rows.length),
        sort: { createdAt: -1 },
      });
      rows.push(...chunk);
      if (chunk.length < STAGE_SCAN_BATCH) break;
    }
    return rows;
  }

  /**
   * Resolve an admin's orders search term into a Mongo clause.
   */
  async buildOrderSearch(search) {
    const term = String(search || '').trim();
    if (!term) return null;
    const rx = new RegExp(escapeRegex(term), 'i');

    const clauses = [{ 'user.name': rx }, { 'user.email': rx }];
    if (isValidObjectId(term)) clauses.push({ _id: term });

    const [identityResult, shops] = await Promise.all([
      identityClient.searchUsers(term, 50),
      shopRepo
        .findAll({ $or: [{ name: rx }, { email: rx }, { phoneNumber: rx }] }, { limit: 50 })
        .catch(() => []),
    ]);

    const people = identityClient
      .displayUsers(identityResult)
      .map((user) => String(user.id || user._id || ''))
      .filter(Boolean);
    if (people.length) {
      clauses.push({ buyerId: { $in: people } });
      clauses.push({ sellerId: { $in: people } });
    }

    const shopRows = shops || [];
    const shopIds = shopRows.map((shop) => String(shop._id || shop.id || '')).filter(Boolean);
    const shopOwners = shopRows.map((shop) => String(shop.ownerId || '')).filter(Boolean);
    if (shopIds.length) clauses.push({ 'sellerShipments.shopId': { $in: shopIds } });
    if (shopOwners.length) clauses.push({ sellerId: { $in: shopOwners } });

    return { $or: clauses };
  }

  /**
   * Give a page of order rows the shop, business and people behind them.
   */
  async hydrateOrderRows(rows = []) {
    const shopIds = [];
    const businessIds = [];
    const ownerIds = [];
    for (const row of rows) {
      for (const shipment of row.sellerShipments || []) {
        if (shipment.shopId) shopIds.push(shipment.shopId);
        if (shipment.businessId) businessIds.push(shipment.businessId);
      }
      if (row.sellerId) ownerIds.push(row.sellerId);
    }

    const uniqueShops = [...new Set(shopIds.map(String))];
    const [shopRows, { owners, businesses }] = await Promise.all([
      uniqueShops.length
        ? shopRepo.findAll({ _id: { $in: uniqueShops } }, { limit: uniqueShops.length }).catch(() => [])
        : Promise.resolve([]),
      adminBusinessesService.hydrateOwnership(ownerIds, businessIds),
    ]);

    const shopsById = new Map();
    for (const shop of shopRows || []) {
      const id = String(shop._id || shop.id || '');
      if (id) shopsById.set(id, shop);
    }

    return rows.map((row) => {
      const shipment = (row.sellerShipments || [])[0] || null;
      const shop = shipment && shipment.shopId ? shopsById.get(String(shipment.shopId)) || null : null;
      const businessId = (shipment && shipment.businessId) || (shop && shop.businessId) || null;
      const business = businessId ? businesses.get(String(businessId)) || null : null;
      const owner = row.sellerId ? owners.get(String(row.sellerId)) || null : null;
      const sellerShipments = (row.sellerShipments || []).map((s) => {
        const sShop = s && s.shopId ? shopsById.get(String(s.shopId)) || null : null;
        const sBizId = (s && s.businessId) || (sShop && sShop.businessId) || null;
        const sBiz = sBizId ? businesses.get(String(sBizId)) || null : null;
        return {
          ...s,
          shopName: sShop ? sShop.name : null,
          businessId: sBizId,
          businessName: sBiz ? sBiz.name || null : null,
        };
      });
      return {
        ...row,
        sellerShipments,
        shopId: (shipment && shipment.shopId) || (shop ? String(shop._id) : null),
        shopName: shop ? shop.name : null,
        businessId,
        businessName: business ? business.name : null,
        sellerName: owner ? owner.name || null : null,
        sellerEmail: owner ? owner.email || null : null,
        buyerName: (row.user && row.user.name) || null,
        buyerEmail: (row.user && row.user.email) || null,
      };
    });
  }

  /**
   * Paginated orders with combinable filters: hierarchy / seller / status /
   * paymentStatus / stage / date range / free-text search.
   */
  async getOrders(filters = {}) {
    const { sellerId, status, paymentStatus, stage, from, to, search, page, limit } = filters;
    const { page: safePage, limit: safeLimit, skip } = paginate(page, limit);

    const query = {};
    if (status) {
      const requested = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      const normalized = requested.map((s) => normalizeStatus(s));
      const unknown = normalized.filter((s) => !ORDER_STATUS_VALUES.includes(s));
      if (unknown.length > 0) {
        throw Object.assign(
          new Error(`Unknown order status: ${unknown.join(', ')}`),
          { status: 400, code: 'UNKNOWN_STATUS', allowed: ORDER_STATUS_VALUES }
        );
      }
      query.status = normalized.length === 1 ? normalized[0] : { $in: normalized };
    }
    if (paymentStatus) {
      const requestedPayment = String(paymentStatus).toUpperCase();
      if (!PAYMENT_STATUS_VALUES.includes(requestedPayment)) {
        throw Object.assign(
          new Error(`Unknown payment status: ${requestedPayment}`),
          { status: 400, code: 'UNKNOWN_PAYMENT_STATUS', allowed: PAYMENT_STATUS_VALUES }
        );
      }
      query.paymentStatus = requestedPayment;
    }
    if (sellerId) query.sellerId = String(sellerId);
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    if (filters.shopId) query['sellerShipments.shopId'] = String(filters.shopId);
    if (filters.businessId) query['sellerShipments.businessId'] = String(filters.businessId);

    const scope = await adminHierarchyService.resolveHierarchyScope(filters);
    const emptyResult = {
      orders: [],
      total: 0,
      page: safePage,
      limit: safeLimit,
      totalPages: 0,
      stageCounts: {},
      stageCountsScope: 'status',
      scopeApplied: scope.scoped,
      stageDefinitions: this.stageDefinitions(),
    };

    const searchFilter = await this.buildOrderSearch(search);
    if (searchFilter) Object.assign(query, searchFilter);

    if (scope.scoped) {
      if (!scope.ownerIds.length) return emptyResult;
      const sellerScope = scope.ownerIds.length === 1
        ? scope.ownerIds[0]
        : { $in: scope.ownerIds };
      if (query.sellerId && !scope.ownerIds.includes(query.sellerId)) {
        return emptyResult;
      }
      if (!query.sellerId) query.sellerId = sellerScope;
    }

    if (stage) {
      const candidates = await this.collectScopedOrders(query);
      const deliveries = await this.resolveDeliveries(candidates.map((order) => String(order._id)));
      const all = candidates.map((order) => this.toOrderRow(order, deliveries[String(order._id)] || null));

      const stageCounts = {};
      for (const row of all) stageCounts[row.stage] = (stageCounts[row.stage] || 0) + 1;

      const matched = all.filter((row) => row.stage === stage);
      const total = matched.length;

      return {
        orders: await this.hydrateOrderRows(matched.slice(skip, skip + safeLimit)),
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 0,
        stageCounts,
        stageCountsScope: 'scan',
        stageScanCapped: candidates.length >= STAGE_SCAN_LIMIT,
        scopeApplied: scope.scoped,
        stageDefinitions: this.stageDefinitions(),
      };
    }

    const [orders, total, statusCounts] = await Promise.all([
      orderRepo.findAll(query, { skip, limit: safeLimit, sort: { createdAt: -1 } }),
      orderRepo.count(query),
      orderRepo.countByField('status', query),
    ]);

    const deliveries = await this.resolveDeliveries(orders.map((order) => String(order._id)));
    const rows = await this.hydrateOrderRows(
      orders.map((order) => this.toOrderRow(order, deliveries[String(order._id)] || null))
    );

    const stageCounts = {};
    for (const row of statusCounts) {
      const key = lifecycle.mapOrderStatusToStage(row._id);
      stageCounts[key] = (stageCounts[key] || 0) + row.count;
    }

    return {
      orders: rows,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
      stageCounts,
      stageCountsScope: 'status',
      scopeApplied: scope.scoped,
      stageDefinitions: this.stageDefinitions(),
    };
  }

  stageDefinitions() {
    return lifecycle.OPERATIONAL_STAGES.map((key) => ({ stage: key, label: lifecycle.stageLabel(key) }));
  }

  /**
   * Bulk delivery lookup for a bounded page of orders.
   */
  async resolveDeliveries(orderIds = []) {
    if (!orderIds.length) return {};
    const result = await safe('delivery bulk', deliveryClient.getDeliveriesForOrders(orderIds));
    if (!result.ok) return {};
    const rows = result.data.body.deliveries || [];
    return rows.reduce((map, delivery) => {
      map[String(delivery.orderId)] = delivery;
      return map;
    }, {});
  }

  /**
   * The complete physical journey of one order: Commerce order + Delivery
   * record + delivery events, expressed in the operational vocabulary.
   */
  async getOrderPickupDeliveryLifecycle(orderId) {
    const order = await orderRepo.findByIdLean(orderId);
    if (!order) {
      throw Object.assign(new Error('Order not found'), { status: 404 });
    }

    const deliveryResult = await safe('delivery by order', deliveryClient.getDeliveryByOrderId(orderId));
    const delivery = deliveryResult.ok ? deliveryResult.data.body.delivery : null;
    const deliveryUnavailable = !deliveryResult.ok;

    let history = [];
    if (delivery && delivery._id) {
      const historyResult = await safe('delivery history', deliveryClient.getDeliveryHistory(delivery._id));
      if (historyResult.ok) {
        history = historyResult.data.body.events || historyResult.data.body.history || [];
      }
    }

    const mapped = lifecycle.mapOrderToOperationalStage(order, delivery);

    const timeline = [
      { stage: 'new', label: 'Order Created', timestamp: order.createdAt, source: 'commerce' },
      {
        stage: 'accepted',
        label: 'Accepted',
        timestamp: order.status !== 'Processing' ? order.updatedAt : null,
        source: 'commerce',
      },
      { stage: 'ready_for_pickup', label: 'Ready for Pickup', timestamp: delivery ? delivery.createdAt : null, source: 'delivery' },
      { stage: 'pickup_assigned', label: 'Pickup Assigned', timestamp: delivery ? delivery.updatedAt : null, source: 'delivery' },
      { stage: 'picked_up', label: 'Picked Up', timestamp: delivery ? delivery.pickedUpAt : null, source: 'delivery' },
      { stage: 'in_transit', label: 'In Transit', timestamp: delivery ? delivery.pickedUpAt : null, source: 'delivery' },
      {
        stage: 'delivered',
        label: 'Delivered',
        timestamp: order.deliveredAt || (delivery ? delivery.deliveredAt : null),
        source: 'commerce/delivery',
      },
    ].filter((entry) => entry.timestamp);

    const shipments = Array.isArray(order.sellerShipments) ? order.sellerShipments : [];
    const shipmentShopIds = [...new Set(shipments.map((s) => s && s.shopId).filter(Boolean).map(String))];
    const shipmentBusinessIds = [...new Set(shipments.map((s) => s && s.businessId).filter(Boolean).map(String))];
    const [shopRows, { owners, businesses }] = await Promise.all([
      shipmentShopIds.length
        ? shopRepo.findAll({ _id: { $in: shipmentShopIds } }, { limit: shipmentShopIds.length }).catch(() => [])
        : Promise.resolve([]),
      adminBusinessesService.hydrateOwnership([order.sellerId], shipmentBusinessIds),
    ]);
    const shopsById = new Map();
    for (const shop of shopRows || []) {
      const id = String(shop._id || shop.id || '');
      if (id) shopsById.set(id, shop);
    }
    const lookupShopName = (id) => (id && shopsById.get(String(id)) ? shopsById.get(String(id)).name : null);
    const lookupBusinessName = (id) => (id && businesses.get(String(id)) ? businesses.get(String(id)).name : null);

    const primaryShopId = shipments[0] && shipments[0].shopId ? String(shipments[0].shopId) : null;
    const primaryBusinessId =
      (shipments[0] && shipments[0].businessId) ||
      (primaryShopId && shopsById.get(primaryShopId) ? shopsById.get(primaryShopId).businessId : null) ||
      null;
    const seller = order.sellerId ? owners.get(String(order.sellerId)) || null : null;
    const enrichedShipments = shipments.map((shipment) => ({
      ...shipment,
      shopName: lookupShopName(shipment && shipment.shopId),
      businessName: lookupBusinessName(shipment && shipment.businessId),
    }));

    return {
      order: {
        id: String(order._id),
        status: order.status,
        paymentStatus: order.paymentStatus,
        totalPrice: order.totalPrice,
        items: Array.isArray(order.cart) ? order.cart : [],
        buyerId: order.buyerId || null,
        sellerId: order.sellerId || null,
        buyerName: (order.user && order.user.name) || null,
        buyerEmail: (order.user && order.user.email) || null,
        sellerName: seller ? seller.name || null : null,
        sellerEmail: seller ? seller.email || null : null,
        shopId: primaryShopId,
        shopName: lookupShopName(primaryShopId),
        businessId: primaryBusinessId,
        businessName: lookupBusinessName(primaryBusinessId),
        destination: order.destination || null,
        sellerShipments: enrichedShipments,
        createdAt: order.createdAt,
      },
      stage: mapped.stage,
      stageLabel: lifecycle.stageLabel(mapped.stage),
      stageReason: mapped.reason,
      pickup: {
        sellerId: order.sellerId || null,
        locationId: delivery ? delivery.pickupLocationId : null,
        address: delivery ? delivery.pickupAddress : null,
        origin: order.sellerShipments && order.sellerShipments[0] ? order.sellerShipments[0].origin : null,
        status: delivery ? delivery.status : null,
        actorId: delivery ? delivery.actorId : null,
        readyAt: delivery ? delivery.createdAt : null,
        pickedUpAt: delivery ? delivery.pickedUpAt : null,
      },
      dropOff: {
        destinationLocationId: delivery ? delivery.destinationLocationId : null,
        address: delivery ? delivery.deliveryAddress : null,
        destination: order.destination || null,
        zoneId: delivery && delivery.deliveryAddress ? delivery.deliveryAddress.zoneId : null,
        deliveredAt: delivery ? delivery.deliveredAt : null,
        proofOfDelivery: delivery ? delivery.proofOfDelivery : null,
        failureReason: delivery ? delivery.failureReason : null,
        cancelledAt: delivery ? delivery.cancelledAt : null,
        cancellationReason: delivery ? delivery.cancellationReason : null,
      },
      timeline,
      history,
      deliveryUnavailable,
      tracking: lifecycle.UNSUPPORTED_STAGES,
    };
  }

  /**
   * Operational stage counters, combining Commerce order statuses with
   * Delivery's physical counters.
   */
  async getOperationsOverview() {
    const [orderStatusCounts, settledDelivered] = await Promise.all([
      orderRepo.countByField('status'),
      orderRepo.count({ status: 'Delivered', paymentStatus: 'CONFIRMED' }),
    ]);

    const counts = {};
    for (const stage of lifecycle.OPERATIONAL_STAGES) counts[stage] = 0;
    for (const row of orderStatusCounts) {
      const stage = lifecycle.mapOrderStatusToStage(row._id);
      counts[stage] = (counts[stage] || 0) + row.count;
    }
    counts.completed = settledDelivered;

    const deliveryResult = await safe('delivery ops', deliveryClient.getInternalOperationsDashboard());
    const delivery = deliveryResult.ok ? deliveryResult.data.body.dashboard : null;

    if (delivery) {
      const byStatus = delivery.byStatus || {};
      const deliveryCount = (status) => {
        const value = byStatus[status];
        return Number.isFinite(value) ? value : null;
      };
      const readyPool = delivery.activeReadyPool ?? null;
      const stageCountsFromDelivery = {
        ready_for_pickup: readyPool ?? deliveryCount('pending'),
        pickup_assigned: sumStatuses(deliveryCount, ['assigned', 'reassigned']),
        picked_up: deliveryCount('pickup'),
        in_transit: deliveryCount('in_transit'),
        exception: deliveryCount('failed'),
        cancelled: deliveryCount('cancelled'),
      };
      for (const [stage, count] of Object.entries(stageCountsFromDelivery)) {
        if (count === null) continue;
        counts[stage] = stage === 'exception' || stage === 'cancelled'
          ? (counts[stage] || 0) + count
          : count;
      }
    }

    const stages = lifecycle.OPERATIONAL_STAGES.map((stage) => ({
      stage,
      label: lifecycle.stageLabel(stage),
      count: counts[stage] === undefined ? null : counts[stage],
      drilldown: `/api/admin/operations/${stage}`,
    }));

    const known = stages.reduce((sum, entry) => sum + (entry.count || 0), 0);

    return {
      stages,
      total: known,
      deliveryAvailable: Boolean(delivery),
      delivery: delivery
        ? {
          byStatus: delivery.byStatus || {},
          active: delivery.active,
          failed: delivery.failed,
          providers: delivery.providers,
        }
        : null,
      unsupportedStages: lifecycle.UNSUPPORTED_STAGES,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Drill-down: the orders currently in one operational stage (paginated). */
  async getOperationsOrders(stage, filters = {}) {
    if (stage && !lifecycle.OPERATIONAL_STAGES.includes(stage)) {
      throw Object.assign(
        new Error(`Unknown operational stage "${stage}". Known stages: ${lifecycle.OPERATIONAL_STAGES.join(', ')}`),
        { status: 400 }
      );
    }
    return this.getOrders({ ...filters, stage });
  }
}

module.exports = new AdminOrdersService();
module.exports.AdminOrdersService = AdminOrdersService;
