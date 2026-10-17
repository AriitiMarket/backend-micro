const orderRepository = require('../../fulfillment/repositories/orders.repository');
const shopRepository = require('../../selling/repositories/shops.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const Dispute = require('../../fulfillment/models/Dispute');
const StockMovement = require('../../catalog/models/StockMovements');
const Payment = require('../../fulfillment/models/Payments');
const hierarchyScope = require('../../../shared/utils/hierarchyScope');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const { identityClient } = require('../../../app/clients/identity.client');
const { normalizeStatus, ORDER_STATUSES } = require('../../fulfillment/constants/orderStatuses');

/**
 * Canonical status spellings that represent a completed (revenue-recognizing)
 * order. Stored docs use the canonical enum; legacy uppercase/alias spellings
 * are included so revenue is never under-counted for old rows.
 */
const REVENUE_STATUSES = [
  ORDER_STATUSES.DELIVERED,        // 'Delivered'
  'Delivered', 'DELIVERED',
  'Completed', 'COMPLETED',
  'Succeeded', 'SUCCEEDED',
  'Received', 'RECEIVED',
];

/**
 * Canonical status spellings that represent a refunded order (money returned
 * to the buyer, subtracted from net sales).
 */
const REFUNDED_STATUSES = [
  ORDER_STATUSES.REFUND_SUCCESS,   // 'Refund Success'
  'Refund Success', 'REFUND SUCCESS',
  'Refunded', 'REFUNDED',
  'Refund Successful', 'REFUND SUCCESSFUL',
];

/**
 * Orders that must never count toward revenue (cancelled or in a refund flow
 * that has not succeeded).
 */
const NON_REVENUE_STATUSES = [
  ORDER_STATUSES.CANCELLED,        // 'Cancelled'
  'Cancelled', 'CANCELLED',
  ORDER_STATUSES.REFUND_REQUESTED, // 'Refund Requested'
  'Refund Requested', 'REFUND REQUESTED',
  ORDER_STATUSES.REFUND_APPROVED,  // 'Refund Approved'
  'Refund Approved', 'REFUND APPROVED',
  ORDER_STATUSES.PROCESSING,       // 'Processing'
  'Processing', 'PENDING', 'NEW', 'ORDERED',
  ORDER_STATUSES.CONFIRMED,        // 'Confirmed'
  'Confirmed', 'CONFIRMED', 'ACCEPTED',
  ORDER_STATUSES.SHIPPED,          // 'Shipped'
  'Shipped', 'SHIPPED',
  ORDER_STATUSES.IN_TRANSIT,       // 'In Transit'
  'In Transit', 'IN TRANSIT',
];

class AnalyticsService {

  _dateFilter(startDate, endDate) {
    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    return filter;
  }

  /**
   * Resolves the admin hierarchy selection into query filters for the Commerce
   * collections that can honestly be scoped.
   */
  async _scope(filters = {}) {
    const scope = await hierarchyScope.resolveHierarchyScope(filters);
    if (!scope.scoped) {
      return { scoped: false, orderFilter: {}, shopFilter: {}, disputeFilter: {}, scopeNote: null };
    }
    const sellerFilter = {
      sellerId: scope.ownerIds.length === 1 ? scope.ownerIds[0] : { $in: scope.ownerIds },
    };
    return {
      scoped: true,
      orderFilter: sellerFilter,
      shopFilter: scope.shopFilter,
      disputeFilter: { ...sellerFilter },
      scopeNote:
        'orders, shops and disputes are scoped to the selected hierarchy; users, riders, products and deliveries are platform-wide',
    };
  }

  /** ANDs several filters into one, ignoring empty ones. */
  _merge(...filters) {
    return Object.assign({}, ...filters.filter((f) => f && Object.keys(f).length));
  }

  /**
   * Sum of totalPrice for revenue-recognizing (delivered/completed) orders
   * matching the filter (database-side). Cancelled, pending and refunded
   * orders are excluded so revenue is never overstated.
   */
  async _revenueFor(filter) {
    const [row] = await orderRepository.aggregate([
      { $match: this._merge(filter, { status: { $in: REVENUE_STATUSES } }) },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } },
    ]);
    return row?.total || 0;
  }

  /**
   * Sum of totalPrice for refunded orders matching the filter (database-side).
   * These amounts are subtracted from gross sales to arrive at net sales.
   */
  async _refundsFor(filter) {
    const [row] = await orderRepository.aggregate([
      { $match: this._merge(filter, { status: { $in: REFUNDED_STATUSES } }) },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } },
    ]);
    return row?.total || 0;
  }

  async getStats(startDate, endDate, filters = {}) {
    try {
      const scope = await this._scope(filters);
      const baseFilter = this._merge(this._dateFilter(startDate, endDate), scope.orderFilter);

      // Aggregate in the database — never load 100k full order documents.
      const [moneyRow, statusRows, totalCount, shops, products, identityCounts, deliveryDashboard] = await Promise.all([
        orderRepository.aggregate([
          { $match: baseFilter },
          { $group: { _id: null, total: { $sum: '$totalPrice' }, count: { $sum: 1 } } },
        ]),
        orderRepository.countByField('status', baseFilter),
        orderRepository.count(baseFilter),
        shopRepository.find({ filter: scope.shopFilter }),
        productRepository.findAll({}),
        identityClient.countUsers(),
        deliveryClient.getInternalOperationsDashboard(),
      ]);

      const grossRevenue = await this._revenueFor(baseFilter);
      const refunds = await this._refundsFor(baseFilter);
      const netRevenue = grossRevenue - refunds;

      // Normalize legacy spellings so 'DELIVERED' and 'Delivered' merge.
      let deliveredOrders = 0;
      let cancelledOrders = 0;
      for (const row of statusRows || []) {
        const s = normalizeStatus(row._id);
        if (s === ORDER_STATUSES.DELIVERED) deliveredOrders += row.count;
        if (s === ORDER_STATUSES.CANCELLED) cancelledOrders += row.count;
      }

      const counts = identityCounts?.body?.counts || {};
      const delivery = deliveryDashboard?.body?.dashboard || null;

      return {
        totalUsers: counts.total || 0,
        totalSellers: counts.sellers || 0,
        totalStores: shops.length,
        totalRiders: delivery?.providers?.total || 0,
        totalProducts: products.length,
        totalOrders: totalCount,
        deliveredOrders,
        cancelledOrders,
        grossSales: grossRevenue,
        refunds,
        netSales: netRevenue,
        totalRevenue: grossRevenue,
        avgOrderValue: deliveredOrders > 0 ? Math.round(grossRevenue / deliveredOrders) : 0,
        deliveryRate: totalCount > 0 ? Math.round((deliveredOrders / totalCount) * 100) : 0,
        scopeApplied: scope.scoped,
        scopeNote: scope.scopeNote,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      console.error('Analytics getStats error:', err);
      return { totalUsers: 0, totalSellers: 0, totalStores: 0, totalRiders: 0, totalProducts: 0, totalOrders: 0, deliveredOrders: 0, cancelledOrders: 0, grossSales: 0, refunds: 0, netSales: 0, totalRevenue: 0, avgOrderValue: 0, deliveryRate: 0, scopeApplied: false, scopeNote: null, timestamp: new Date().toISOString() };
    }
  }

  async getGrowth(startDate, endDate, filters = {}) {
    try {
      const scope = await this._scope(filters);
      const now = new Date();
      const months = [];
      const storesCount = [];
      const ordersCount = [];
      const revenueCount = [];

      for (let i = 11; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
        months.push(monthStart.toLocaleString('en', { month: 'short' }));

        const window = { createdAt: { $gte: monthStart, $lte: monthEnd } };

        const [orders, shops] = await Promise.all([
          orderRepository.count(this._merge(window, scope.orderFilter)),
          shopRepository.count(this._merge(window, scope.shopFilter)),
        ]);

        ordersCount.push(orders);
        revenueCount.push(await this._revenueFor(this._merge(window, scope.orderFilter)));
        storesCount.push(shops);
      }

      return { labels: months, storesCount, ordersCount, revenueCount };
    } catch (err) {
      console.error('Analytics getGrowth error:', err);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return { labels: months, storesCount: [], ordersCount: [], revenueCount: [] };
    }
  }

  async getOrdersByType(startDate, endDate, filters = {}, opts = {}) {
    try {
      const scope = await this._scope(filters);
      const { skip = 0, limit = 500 } = opts;
      const orders = await orderRepository.findAll(
        this._merge(this._dateFilter(startDate, endDate), scope.orderFilter),
        { skip, limit, sort: { createdAt: -1 } }
      );

      const delivery = orders.filter(o => o.orderType === 'delivery' || o.type === 'delivery').length;
      const pickup = orders.filter(o => o.orderType === 'pickup' || o.type === 'pickup').length;
      const dineIn = orders.filter(o => o.orderType === 'dine_in' || o.type === 'dine_in').length;

      return [
        { label: 'Delivery', value: delivery },
        { label: 'Pickup', value: pickup },
        { label: 'Dine In', value: dineIn },
      ];
    } catch (err) {
      console.error('Analytics getOrdersByType error:', err);
      return [{ label: 'Delivery', value: 0 }, { label: 'Pickup', value: 0 }, { label: 'Dine In', value: 0 }];
    }
  }

  async getSalesByType(startDate, endDate, filters = {}, opts = {}) {
    try {
      const scope = await this._scope(filters);
      const { skip = 0, limit = 500 } = opts;
      const orders = await orderRepository.findAll(
        this._merge(this._dateFilter(startDate, endDate), scope.orderFilter),
        { skip, limit, sort: { createdAt: -1 } }
      );

      const delivered = orders.filter(o => REVENUE_STATUSES.includes(normalizeStatus(o.status)));
      const refunded = orders.filter(o => REFUNDED_STATUSES.includes(normalizeStatus(o.status)));

      return {
        delivery: delivered.reduce((sum, o) => sum + (o.totalPrice || 0), 0),
        pickup: 0,
        refunded: refunded.reduce((sum, o) => sum + (o.totalPrice || 0), 0),
      };
    } catch (err) {
      return { delivery: 0, pickup: 0, refunded: 0 };
    }
  }

  async getSalesOverTime(startDate, endDate, filters = {}, opts = {}) {
    try {
      const scope = await this._scope(filters);
      const { skip = 0, limit = 500 } = opts;
      const orders = await orderRepository.findAll(
        this._merge(this._dateFilter(startDate, endDate), scope.orderFilter),
        { skip, limit, sort: { createdAt: -1 } }
      );

      const dailyMap = {};
      orders.forEach(o => {
        const st = normalizeStatus(o.status);
        if (!REVENUE_STATUSES.includes(st)) return;
        const day = new Date(o.createdAt || o._id.getTimestamp()).toISOString().split('T')[0];
        if (!dailyMap[day]) dailyMap[day] = { date: day, revenue: 0, count: 0 };
        dailyMap[day].revenue += o.totalPrice || 0;
        dailyMap[day].count += 1;
      });

      return Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    } catch (err) {
      return [];
    }
  }

  async getOrdersByStatus(startDate, endDate, filters = {}) {
    try {
      const scope = await this._scope(filters);
      const rows = await orderRepository.countByField(
        'status',
        this._merge(this._dateFilter(startDate, endDate), scope.orderFilter)
      );

      const statusCounts = {};
      for (const row of rows || []) {
        const s = normalizeStatus(row._id) || 'unknown';
        statusCounts[s] = (statusCounts[s] || 0) + row.count;
      }

      return Object.entries(statusCounts).map(([status, count]) => ({ label: status, value: count }));
    } catch (err) {
      return [];
    }
  }

  async getCategoryActivity(startDate, endDate) {
    try {
      const dateFilter = this._dateFilter(startDate, endDate);
      const products = await productRepository.findAll(dateFilter);

      const categoryCounts = {};
      products.forEach(p => {
        const cat = p.category || 'Uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      });

      return Object.entries(categoryCounts)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);
    } catch (err) {
      return [];
    }
  }

  async getProductStats(startDate, endDate) {
    try {
      const allProducts = await productRepository.findAll({});

      const lowStock = allProducts.filter(p => p.stock <= (p.lowStockThreshold || 5)).length;
      const outOfStock = allProducts.filter(p => p.stock === 0).length;
      const totalStock = allProducts.reduce((sum, p) => sum + (p.stock || 0), 0);
      const avgPrice = allProducts.length > 0
        ? Math.round(allProducts.reduce((sum, p) => sum + (p.discountPrice || p.originalPrice || 0), 0) / allProducts.length)
        : 0;

      return {
        totalProducts: allProducts.length,
        lowStock,
        outOfStock,
        totalStock,
        avgPrice,
      };
    } catch (err) {
      return { totalProducts: 0, lowStock: 0, outOfStock: 0, totalStock: 0, avgPrice: 0 };
    }
  }

  async getDisputeStats(startDate, endDate, filters = {}) {
    try {
      const scope = await this._scope(filters);
      const dateFilter = this._dateFilter(startDate, endDate);

      const [allDisputes, scopedDisputes] = await Promise.all([
        Dispute.find(scope.disputeFilter),
        Dispute.find(this._merge(dateFilter, scope.disputeFilter)),
      ]);

      const statusCounts = {};
      allDisputes.forEach(d => {
        const s = d.status || 'unknown';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      });

      const typeCounts = {};
      scopedDisputes.forEach(d => {
        const t = d.type || 'other';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      });

      const priorityCounts = {};
      scopedDisputes.forEach(d => {
        const p = d.priority || 'medium';
        priorityCounts[p] = (priorityCounts[p] || 0) + 1;
      });

      return {
        total: allDisputes.length,
        newDisputes: scopedDisputes.length,
        open: statusCounts.open || 0,
        inProgress: statusCounts.in_progress || 0,
        resolved: statusCounts.resolved || 0,
        rejected: statusCounts.rejected || 0,
        closed: statusCounts.closed || 0,
        byType: Object.entries(typeCounts).map(([type, count]) => ({ type, count })),
        byPriority: Object.entries(priorityCounts).map(([priority, count]) => ({ priority, count })),
      };
    } catch (err) {
      return { total: 0, newDisputes: 0, open: 0, inProgress: 0, resolved: 0, rejected: 0, closed: 0, byType: [], byPriority: [] };
    }
  }

  async getDeliveryStats(startDate, endDate) {
    try {
      const dashboard = await deliveryClient.getInternalOperationsDashboard();
      const d = dashboard?.body?.dashboard || {};
      const delivered = d.byStatus?.delivered || 0;
      return {
        totalRiders: d.providers?.total || 0,
        activeRiders: d.providers?.available || 0,
        totalDeliveries: d.total || 0,
        completedDeliveries: delivered,
        failedDeliveries: d.failed || 0,
        avgDeliveryTime: d.avgDeliveryTime || 0,
        completionRate: d.total > 0 ? Math.round((delivered / d.total) * 100) : 0,
      };
    } catch (err) {
      return { totalRiders: 0, activeRiders: 0, totalDeliveries: 0, completedDeliveries: 0, failedDeliveries: 0, avgDeliveryTime: 0, completionRate: 0 };
    }
  }

  async getRiderPerformance(startDate, endDate) {
    try {
      const { body } = await deliveryClient.listInternalDeliveries({ limit: 100 });
      const deliveries = body?.deliveries || body?.data || [];
      if (!Array.isArray(deliveries) || deliveries.length === 0) return [];

      const byRider = new Map();
      for (const d of deliveries) {
        const id = d.actorId || d.riderId || d.providerId || d.partnerId;
        if (!id) continue;
        const entry = byRider.get(id) || { riderId: id, name: d.actorName || d.riderName || String(id), total: 0, completed: 0, failed: 0 };
        entry.total += 1;
        const st = String(d.status || '').toLowerCase();
        if (st === 'delivered') entry.completed += 1;
        if (st === 'failed' || st === 'cancelled') entry.failed += 1;
        byRider.set(id, entry);
      }
      return Array.from(byRider.values());
    } catch (err) {
      return [];
    }
  }

  async getShopStats(startDate, endDate, filters = {}) {
    try {
      const scope = await this._scope(filters);
      const allShops = await shopRepository.find({ filter: scope.shopFilter });
      const scopedShops = await shopRepository.find({
        filter: this._merge(this._dateFilter(startDate, endDate), scope.shopFilter),
      });

      const statusCounts = {};
      allShops.forEach(s => {
        const st = s.status || 'unknown';
        statusCounts[st] = (statusCounts[st] || 0) + 1;
      });

      return {
        total: allShops.length,
        newShops: scopedShops.length,
        approved: statusCounts.APPROVED || statusCounts.ACTIVE || 0,
        pending: statusCounts.PENDING_APPROVAL || statusCounts.PENDING || 0,
        suspended: statusCounts.SUSPENDED || 0,
        inactive: statusCounts.INACTIVE || 0,
      };
    } catch (err) {
      return { total: 0, newShops: 0, approved: 0, pending: 0, suspended: 0, inactive: 0 };
    }
  }

  /**
   * Seller-scoped report for the authenticated seller's own shop(s).
   *
   * Tenant isolation: the sellerId is taken from the authenticated identity
   * (never trusted from the query string). Orders are attributed to the seller
   * via the top-level `sellerId` field OR any of the seller's shops
   * (`sellerShipments.shopId`). A seller can never reach another seller's data.
   */
  async getSellerStats(startDate, endDate, sellerId) {
    try {
      if (!sellerId) {
        return { error: 'sellerId is required' };
      }

      const shops = await shopRepository.find({ filter: { ownerId: String(sellerId) } });
      const shopIds = shops.map(s => String(s._id));

      const orderFilter = this._merge(
        this._dateFilter(startDate, endDate),
        {
          $or: [
            { sellerId: String(sellerId) },
            ...(shopIds.length ? [{ 'sellerShipments.shopId': { $in: shopIds } }] : []),
          ],
        }
      );

      const [moneyRow, statusRows, totalCount, products] = await Promise.all([
        orderRepository.aggregate([
          { $match: orderFilter },
          { $group: { _id: null, total: { $sum: '$totalPrice' }, count: { $sum: 1 } } },
        ]),
        orderRepository.countByField('status', orderFilter),
        orderRepository.count(orderFilter),
        productRepository.findAll({ filter: { sellerId: String(sellerId) } }),
      ]);

      const grossRevenue = await this._revenueFor(orderFilter);
      const refunds = await this._refundsFor(orderFilter);
      const netRevenue = grossRevenue - refunds;

      let deliveredOrders = 0;
      let cancelledOrders = 0;
      let pendingOrders = 0;
      for (const row of statusRows || []) {
        const s = normalizeStatus(row._id);
        if (s === ORDER_STATUSES.DELIVERED) deliveredOrders += row.count;
        if (s === ORDER_STATUSES.CANCELLED) cancelledOrders += row.count;
        if (s === ORDER_STATUSES.PROCESSING || s === 'Pending' || s === 'CONFIRMED') pendingOrders += row.count;
      }

      // Best-selling products by quantity sold (delivered orders only).
      const bestSellers = await this._bestSellersFor(orderFilter);

      // Low-stock alerts for the seller's products.
      const lowStock = products.filter(p => p.stock <= (p.lowStockThreshold || 5) && p.stock > 0).length;
      const outOfStock = products.filter(p => p.stock === 0).length;

      const totalStock = products.reduce((sum, p) => sum + (p.stock || 0), 0);

      return {
        sellerId,
        shopCount: shops.length,
        totalOrders: totalCount,
        deliveredOrders,
        cancelledOrders,
        pendingOrders,
        grossSales: grossRevenue,
        refunds,
        netSales: netRevenue,
        totalRevenue: grossRevenue,
        avgOrderValue: deliveredOrders > 0 ? Math.round(grossRevenue / deliveredOrders) : 0,
        totalProducts: products.length,
        lowStock,
        outOfStock,
        totalStock,
        bestSellers,
        period: { startDate, endDate },
        currency: 'ETB',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      console.error('Analytics getSellerStats error:', err);
      return { error: 'Failed to load seller report' };
    }
  }

  /**
   * Best-selling products aggregated from order cart lines (database-side where
   * possible). Returns [{ productId, name, quantity, revenue }].
   */
  async _bestSellersFor(filter, limit = 10) {
    try {
      const orders = await orderRepository.findAll(filter, { limit: 500, sort: { createdAt: -1 } });
      const qtyById = new Map();
      const revById = new Map();
      const nameById = new Map();

      orders.forEach((o) => {
        (o.cart || []).forEach((li) => {
          const id = li.productId || li.product || li._id || 'unknown';
          const qty = Number(li.quantity) || 1;
          const price = Number(li.price || li.unitPrice || 0);
          const cur = qtyById.get(id) || { quantity: 0, revenue: 0 };
          cur.quantity += qty;
          cur.revenue += qty * price;
          qtyById.set(id, cur);
          revById.set(id, cur.revenue);
          if (li.name && !nameById.has(id)) nameById.set(id, li.name);
        });
      });

      return [...qtyById.entries()]
        .map(([id, { quantity, revenue }]) => ({ productId: id, name: nameById.get(id) || 'Product', quantity, revenue }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, limit);
    } catch (err) {
      return [];
    }
  }

  async getOrdersByTypeRaw() { return this.getOrdersByType(); }
  async getSalesByTypeRaw() { return this.getSalesByType(); }

  async getDashboardUsers() {
    try {
      const identityCounts = await identityClient.countUsers();
      const shops = await shopRepository.find({ filter: {} });
      const deliveryDashboard = await deliveryClient.getInternalOperationsDashboard();
      const counts = identityCounts?.body?.counts || {};
      const delivery = deliveryDashboard?.body?.dashboard || {};
      return {
        users: counts.total || 0,
        sellers: counts.sellers || 0,
        stores: shops.length,
        riders: delivery.providers?.total || 0,
      };
    } catch (err) {
      return { users: 0, sellers: 0, stores: 0, riders: 0 };
    }
  }

  async getPendingApprovals() {
    try {
      const pendingStores = await shopRepository.count({ status: 'PENDING_APPROVAL' });
      const pendingShopsAlt = await shopRepository.count({ status: 'PENDING' });
      const stores = pendingStores + pendingShopsAlt;
      return {
        pendingStores: stores,
        pendingRiders: 0,
        pendingSellers: 0,
        total: stores,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return { pendingStores: 0, pendingRiders: 0, pendingSellers: 0, total: 0, timestamp: new Date().toISOString() };
    }
  }

  async getRecentActivity() {
    try {
      const recentOrders = await orderRepository.findAll({}, { limit: 10 });
      return {
        recentOrders: recentOrders.map(order => ({
          id: order._id, shopId: order.shopId, total: order.totalPrice, status: order.status, createdAt: order.createdAt,
        })),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return { recentOrders: [], timestamp: new Date().toISOString() };
    }
  }
}

module.exports = new AnalyticsService();
