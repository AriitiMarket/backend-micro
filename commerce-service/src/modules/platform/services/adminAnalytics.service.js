'use strict';

/**
 * Admin Analytics & Platform KPIs Service
 * Manages platform overview stats, dispute counters, pending administrative action items,
 * and time-bucketed growth analytics.
 */

const shopRepo = require('../../selling/repositories/shops.repository');
const sellerAppRepo = require('../../selling/repositories/sellerApplications.repository');
const orderRepo = require('../../orders/repositories/orders.repository');
const sectorRepo = require('../../selling/repositories/sectors.repository');
const disputesRepo = require('../../after-sales/repositories/disputes.repository');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const { identityClient } = require('../../../app/clients/identity.client');
const { sendAudit } = require('../../../shared/utils/audit-client');
const adminHierarchyService = require('./adminHierarchy.service');

const OPEN_DISPUTE_STATUSES = ['open', 'in_progress', 'under_investigation'];
const TERMINAL_ORDER_STATUSES = ['Delivered', 'Cancelled', 'Refund Success', 'Refund Rejected'];

function toCountMap(rows) {
  const out = {};
  for (const row of rows) {
    if (row && row._id !== null && row._id !== undefined) out[String(row._id)] = row.count;
  }
  return out;
}

async function safe(label, promise) {
  try {
    return { ok: true, data: await promise };
  } catch (err) {
    return { ok: false, data: null, error: `${label}: ${err.message}` };
  }
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

class AdminAnalyticsService {
  async countDisputes() {
    try {
      const [total, ...openCounts] = await Promise.all([
        disputesRepo.count({}),
        ...OPEN_DISPUTE_STATUSES.map((status) => disputesRepo.count({ status })),
      ]);
      return { total, open: openCounts.reduce((sum, value) => sum + value, 0) };
    } catch (err) {
      return { total: 0, open: 0, error: err.message };
    }
  }

  async getPlatformStats(filters = {}) {
    const unavailable = [];
    const scope = await adminHierarchyService.resolveHierarchyScope(filters);

    const shopCountFilter = scope.shopFilter;
    const orderCountFilter = scope.scoped
      ? (scope.ownerIds.length
          ? { sellerId: scope.ownerIds.length === 1 ? scope.ownerIds[0] : { $in: scope.ownerIds } }
          : null)
      : {};
    const applicationCountFilter = scope.applicationFilter;

    const noMatch = scope.scoped && !scope.ownerIds.length;

    const [
      applicationCounts, shopCounts, orderStatusCounts,
      ordersToday, totalOrders, sectors, activeSectors,
      totalShops, activeShops,
    ] = await Promise.all([
      sellerAppRepo.countByField('status', applicationCountFilter),
      shopRepo.countByField('status', shopCountFilter),
      noMatch ? [] : orderRepo.countByField('status', orderCountFilter || {}),
      noMatch ? 0 : orderRepo.count({ ...(orderCountFilter || {}), createdAt: { $gte: startOfToday() } }),
      noMatch ? 0 : orderRepo.count(orderCountFilter || {}),
      sectorRepo.count({}),
      sectorRepo.countActive(),
      shopRepo.count(shopCountFilter),
      shopRepo.count({ ...shopCountFilter, status: { $in: ['ACTIVE', 'APPROVED'] } }),
    ]);

    const applications = toCountMap(applicationCounts);
    const shops = toCountMap(shopCounts);
    const orders = toCountMap(orderStatusCounts);

    const identity = await safe('identity users', identityClient.countUsers());
    if (!identity.ok) unavailable.push('users');

    const deliveryOps = await safe('delivery operations', deliveryClient.getInternalOperationsDashboard());
    if (!deliveryOps.ok) unavailable.push('deliveries');

    const locationCounts = await safe('delivery locations', deliveryClient.getInternalLocationCounts());
    if (!locationCounts.ok) unavailable.push('locations');

    const users = identity.ok ? identity.data.body?.counts : null;
    const delivery = deliveryOps.ok ? deliveryOps.data.body?.dashboard : null;
    const locations = locationCounts.ok ? locationCounts.data.body?.counts : null;

    const disputes = await this.countDisputes();

    const activeOrders = Object.entries(orders)
      .filter(([status]) => !TERMINAL_ORDER_STATUSES.includes(status))
      .reduce((sum, entry) => sum + entry[1], 0);

    return {
      users: {
        total: users ? users.total : null,
        byRole: users ? users.byRole : null,
        active: users ? users.active : null,
        suspended: users ? users.suspended : null,
        banned: users ? users.banned : null,
      },
      businesses: {
        total: Object.values(applications).reduce((sum, value) => sum + value, 0),
        active: applications.APPROVED || 0,
        pending: applications.PENDING_REVIEW || 0,
        rejected: applications.REJECTED || 0,
        suspended: applications.SUSPENDED || 0,
        draft: applications.DRAFT || 0,
      },
      shops: {
        total: totalShops,
        active: activeShops,
        pending: shops.PENDING_APPROVAL || 0,
        suspended: shops.SUSPENDED || 0,
        inactive: shops.INACTIVE || 0,
        unspecified: totalShops - Object.values(shops).reduce((sum, value) => sum + value, 0),
      },
      locations: locations
        ? {
            total: locations.total,
            zones: locations.zones,
            regions: locations.activeByType ? locations.activeByType.region || 0 : null,
            cities: locations.activeByType ? locations.activeByType.city || 0 : null,
            areas: locations.activeByType ? locations.activeByType.area || 0 : null,
          }
        : null,
      sectors: { total: sectors, active: activeSectors },
      orders: {
        total: totalOrders,
        today: ordersToday,
        active: activeOrders,
        byStatus: orders,
        completed: orders.Delivered || 0,
        cancelled: orders.Cancelled || 0,
        awaitingPickup: delivery ? delivery.byStatus?.pending : null,
        inTransit: delivery ? delivery.byStatus?.in_transit : null,
        exception: (orders['Refund Requested'] || 0) + (delivery ? delivery.byStatus?.failed || 0 : 0),
      },
      deliveries: delivery
        ? {
            total: delivery.total,
            active: delivery.active,
            failed: delivery.failed,
            byStatus: delivery.byStatus,
            actors: delivery.actors,
          }
        : null,
      disputes: { total: disputes.total, open: disputes.open },
      pendingActions: {
        businesses: applications.PENDING_REVIEW || 0,
        shops: shops.PENDING_APPROVAL || 0,
        disputes: disputes.open,
        failedDeliveries: delivery ? delivery.byStatus?.failed : null,
        total:
          (applications.PENDING_REVIEW || 0) +
          (shops.PENDING_APPROVAL || 0) +
          disputes.open,
      },
      unavailable,
      scopeApplied: scope.scoped,
      scopeNote: scope.scoped
        ? 'businesses, shops and orders are scoped to the selected hierarchy; users, deliveries and locations are platform-wide'
        : null,
      generatedAt: new Date().toISOString(),
    };
  }

  async getPendingActions({ limit = 20 } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const unavailable = [];

    const [applications, pendingShops, openDisputes] = await Promise.all([
      sellerAppRepo.findAll({ status: 'PENDING_REVIEW' }, { limit: safeLimit }),
      shopRepo.findAll({ status: 'PENDING_APPROVAL' }, { limit: safeLimit }),
      disputesRepo.findAll({ status: { $in: OPEN_DISPUTE_STATUSES } }, { limit: safeLimit }),
    ]);

    const failedDeliveries = await safe(
      'delivery failed list',
      deliveryClient.listInternalDeliveries({ status: 'failed', limit: safeLimit })
    );
    if (!failedDeliveries.ok) unavailable.push('failedDeliveries');

    const businessItems = applications.map((app) => ({
      id: app._id,
      type: 'business_application',
      title:
        app.businessInformation && app.businessInformation.businessName
          ? app.businessInformation.businessName
          : 'Seller application',
      subtitle: app.ownerId,
      status: app.status,
      location: app.location || null,
      sellerType: app.sellerType || null,
      createdAt: app.createdAt,
      action: 'review_business',
      href: `/businesses/${app._id}`,
    }));

    const shopItems = pendingShops.map((shop) => ({
      id: shop._id,
      type: 'shop',
      title: shop.name,
      subtitle: shop.email,
      status: shop.status,
      locationId: shop.locationId || null,
      sectorId: shop.sectorId || null,
      createdAt: shop.createdAt,
      action: 'review_shop',
      href: `/stores/${shop._id}`,
    }));

    const disputeItems = openDisputes.map((dispute) => ({
      id: dispute._id,
      type: 'dispute',
      title: dispute.orderId ? `Dispute on order ${dispute.orderId}` : 'Dispute',
      subtitle: dispute.description || dispute.type || null,
      status: dispute.status,
      priority: dispute.priority || null,
      createdAt: dispute.createdAt,
      action: 'resolve_dispute',
      href: '/disputes',
    }));

    const deliveryItems = failedDeliveries.ok
      ? (failedDeliveries.data.body?.deliveries || []).map((delivery) => ({
          id: String(delivery._id),
          type: 'delivery',
          title: `Failed delivery for order ${delivery.orderId}`,
          subtitle: delivery.failureReason || null,
          status: delivery.status,
          createdAt: delivery.createdAt,
          action: 'handle_failed_delivery',
          href: `/orders/${delivery.orderId}`,
        }))
      : [];

    const items = [...businessItems, ...shopItems, ...disputeItems, ...deliveryItems];

    return {
      items,
      counts: {
        businesses: businessItems.length,
        shops: shopItems.length,
        disputes: disputeItems.length,
        failedDeliveries: deliveryItems.length,
      },
      total: items.length,
      unavailable,
      generatedAt: new Date().toISOString(),
    };
  }

  async getGrowthAnalytics(filters = {}) {
    const {
      granularity = 'day', days = 30, from, to, timezone = 'UTC',
    } = filters;

    const now = to ? new Date(to) : new Date();
    const windowDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const start = from ? new Date(from) : new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const windowMs = Math.max(now.getTime() - start.getTime(), 1);
    const previousStart = new Date(start.getTime() - windowMs);

    const dtFormat = granularity === 'month' ? '%Y-%m' : granularity === 'week' ? '%G-%V' : '%Y-%m-%d';

    const scope = await adminHierarchyService.resolveHierarchyScope(filters);
    const ownerFilter = scope.scoped ? scope.ownerIds : null;
    if (scope.scoped && !ownerFilter.length) {
      return this.emptyGrowth({
        granularity,
        start,
        end: now,
        previousStart,
        comparison: { windowDays, basis: 'same-length window immediately before the selected period' },
      });
    }

    const orderScope = ownerFilter ? { sellerId: { $in: ownerFilter } } : {};
    const applicationScope = scope.scoped ? scope.applicationFilter : {};

    const bucketGroup = (matchStage, extraFields) => ([
      { $match: matchStage },
      {
        $group: {
          _id: { bucket: { $dateToString: { date: '$createdAt', format: dtFormat, timezone } } },
          ...extraFields,
        },
      },
      { $sort: { '_id.bucket': 1 } },
    ]);

    const [orderBuckets, businessBuckets, shopBuckets] = await Promise.all([
      orderRepo.aggregate(bucketGroup(
        { ...orderScope, createdAt: { $gte: previousStart, $lte: now } },
        {
          orders: { $sum: 1 },
          revenue: { $sum: { $ifNull: ['$totalPrice', 0] } },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'Cancelled'] }, 1, 0] } },
        }
      )),
      sellerAppRepo.aggregate(bucketGroup(
        { ...applicationScope, createdAt: { $gte: previousStart, $lte: now } },
        {
          businesses: { $sum: 1 },
          approved: { $sum: { $cond: [{ $eq: ['$status', 'APPROVED'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] } },
        }
      )),
      shopRepo.aggregate(bucketGroup(
        {
          ...(ownerFilter ? { ownerId: { $in: ownerFilter } } : {}),
          createdAt: { $gte: previousStart, $lte: now },
        },
        {
          shops: { $sum: 1 },
          active: { $sum: { $cond: [{ $in: ['$status', ['ACTIVE', 'APPROVED']] }, 1, 0] } },
        }
      )),
    ]);

    const businessByBucket = new Map(businessBuckets.map((row) => [row._id.bucket, row]));
    const shopByBucket = new Map(shopBuckets.map((row) => [row._id.bucket, row]));
    const bucketDateOf = (key) => new Date(key.length === 7 ? `${key}-01` : key);

    const series = [];
    let currentOrders = 0;
    let currentRevenue = 0;
    let previousOrders = 0;
    let previousRevenue = 0;

    for (const row of orderBuckets) {
      const key = row._id.bucket;
      const isCurrentWindow = bucketDateOf(key) >= start;

      if (isCurrentWindow) {
        currentOrders += row.orders;
        currentRevenue += row.revenue;
      } else {
        previousOrders += row.orders;
        previousRevenue += row.revenue;
      }

      series.push(this.toGrowthBucket(row, key, isCurrentWindow, businessByBucket, shopByBucket));
    }

    const known = new Set(series.map((row) => row.bucket));
    for (const key of new Set([...businessByBucket.keys(), ...shopByBucket.keys()])) {
      if (known.has(key)) continue;
      series.push(
        this.toGrowthBucket(
          { orders: 0, revenue: 0, delivered: 0, cancelled: 0 },
          key,
          bucketDateOf(key) >= start,
          businessByBucket,
          shopByBucket
        )
      );
    }

    series.sort((a, b) => (a.bucket < b.bucket ? -1 : 1));

    const percentChange = (current, previous) =>
      previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(2)) : null;

    return {
      granularity,
      window: {
        start: start.toISOString(),
        end: now.toISOString(),
        days: windowDays,
        requestedFrom: from || null,
        requestedTo: to || null,
      },
      comparison: {
        previousStart: previousStart.toISOString(),
        previousEnd: start.toISOString(),
        basis: 'same-length window immediately before the selected period',
        note: 'Change is null when the comparison period has no data — no invented percentages.',
      },
      filters: {
        locationId: filters.locationId || null,
        sectorId: filters.sectorId || null,
        businessId: filters.businessId || null,
        shopId: filters.shopId || null,
        region: filters.region || null,
        city: filters.city || null,
      },
      series,
      summary: {
        orders: currentOrders,
        revenue: Number(currentRevenue.toFixed(2)),
        previousOrders,
        previousRevenue: Number(previousRevenue.toFixed(2)),
        ordersChangePercent: percentChange(currentOrders, previousOrders),
        revenueChangePercent: percentChange(currentRevenue, previousRevenue),
      },
    };
  }

  toGrowthBucket(row, key, isCurrentWindow, businessByBucket, shopByBucket) {
    const business = businessByBucket.get(key);
    const shop = shopByBucket.get(key);
    return {
      bucket: key,
      period: isCurrentWindow ? 'current' : 'previous',
      orders: row.orders,
      revenue: Number((row.revenue || 0).toFixed(2)),
      delivered: row.delivered,
      cancelled: row.cancelled,
      businesses: business ? business.businesses : 0,
      businessesApproved: business ? business.approved : 0,
      businessesRejected: business ? business.rejected : 0,
      shops: shop ? shop.shops : 0,
      shopsActive: shop ? shop.active : 0,
    };
  }

  emptyGrowth({ granularity, start, end, previousStart, comparison }) {
    return {
      granularity,
      window: { start: start.toISOString(), end: end.toISOString() },
      comparison: { previousStart: previousStart.toISOString(), previousEnd: start.toISOString(), ...comparison },
      series: [],
      summary: { orders: 0, revenue: 0, previousOrders: 0, previousRevenue: 0, ordersChangePercent: null, revenueChangePercent: null },
      note: 'No shops match the selected hierarchy filters, so there is nothing to aggregate.',
    };
  }

  async logAuditAction(entry = {}) {
    if (!entry.action) return { ok: false, error: 'action is required' };
    return sendAudit({ module: 'commerce', ...entry });
  }
}

module.exports = new AdminAnalyticsService();
