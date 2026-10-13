/**
 * Admin Platform Service — the Commerce half of the Platform Admin Control
 * Center.
 *
 * Owns everything Commerce owns: businesses (seller applications), shops,
 * orders, sectors, categories, disputes. Cross-domain reads go over the
 * existing service clients (Delivery for locations/zones/deliveries, Identity
 * for user aggregates) and never touch another service's database.
 *
 * Design rules enforced here:
 *   * counts are computed in the database (aggregations / countDocuments) —
 *     the platform dataset is never loaded into memory;
 *   * cross-service calls are "safe": a downstream outage degrades a metric
 *     (null + `unavailable` marker) instead of failing the whole dashboard;
 *   * statuses are only ever mapped (admin/lifecycle/orderLifecycle.js), never
 *     re-defined.
 */
const shopRepo = require('../../selling/repositories/shops.repository');
const { toAdminRow } = require('../../selling/shops.mapper');
const {
  computeProductCountsByShop,
  computeShopRatings,
} = require('../../selling/repositories/shops.public.repository');
const sellerAppRepo = require('../../selling/repositories/sellerApplications.repository');
const sellerApplicationsService = require('../../selling/services/sellerApplications.service');
const orderRepo = require('../../fulfillment/repositories/orders.repository');
const productRepo = require('../../catalog/repositories/products.repository');
const sectorRepo = require('../../selling/repositories/sectors.repository');
const disputesRepo = require('../../fulfillment/repositories/disputes.repository');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const { identityClient } = require('../../../app/clients/identity.client');
const { sendAudit } = require('../../../shared/utils/audit-client');
const hierarchyScope = require('../../../shared/utils/hierarchyScope');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const lifecycle = require('../lifecycle/orderLifecycle');
const {
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
  normalizeStatus,
} = require('../../fulfillment/constants/orderStatuses');

// --- Shared helpers --------------------------------------------------------

const APPLICATION_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'];
const SHOP_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'];
const OPEN_DISPUTE_STATUSES = ['open', 'in_progress', 'under_investigation'];
const TERMINAL_ORDER_STATUSES = ['Delivered', 'Cancelled', 'Refund Success', 'Refund Rejected'];

/**
 * Cap for scanning orders when a DERIVED filter (the operational stage) has to be
 * evaluated across a whole scoped set. When this cap is reached the response says
 * so via `stageScanCapped`, instead of silently reporting partial numbers.
 */
const STAGE_SCAN_LIMIT = 5000;
const STAGE_SCAN_BATCH = 500;

/**
 * Sum per-status counters, treating a missing counter as "not reported" rather
 * than as zero: a stage whose backing statuses are absent must surface as null
 * (unknown) instead of an authoritative 0.
 */
function sumStatuses(countFor, statuses) {
  let total = 0;
  for (const status of statuses) {
    const value = countFor(status);
    if (value === null) return null;
    total += value;
  }
  return total;
}

function toCountMap(rows) {
  const out = {};
  for (const row of rows) {
    if (row && row._id !== null && row._id !== undefined) out[String(row._id)] = row.count;
  }
  return out;
}

/**
 * Runs a cross-service call without letting a downstream failure break the
 * admin console. Returns `{ ok, data, error }`.
 */
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

function paginate(page, limit, defaults = { page: 1, limit: 50, maxLimit: 200 }) {
  const safePage = Math.max(parseInt(page, 10) || defaults.page, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || defaults.limit, 1), defaults.maxLimit);
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

function nameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class AdminPlatformService {
  // -------------------------------------------------------------------------
  // Hierarchy scope resolution
  // -------------------------------------------------------------------------

  /**
   * Expands location ids (any level) to themselves plus every descendant id,
   * using the Delivery-owned location tree.
   *
   * Delegates to the shared resolver (utils/hierarchyScope) so the admin console
   * and the analytics service can never disagree about what a scope means.
   */
  async expandLocationIds(ids) {
    return hierarchyScope.expandLocationIds(ids);
  }

  /**
   * Normalises every hierarchy-filter spelling the admin console can send into
   * one Commerce scope.
   *
   * The implementation lives in utils/hierarchyScope — the single place a scope
   * is resolved, shared with the analytics service. The rules that matter:
   *   * `regionId/cityId/areaId/sectorId/businessId/shopId` (the frontend
   *     contract in `Aritii-admin-web/src/utils/hierarchyQueryBuilder.ts`) plus
   *     the legacy `locationId/location/region/city/sector` spellings are all
   *     accepted, so a filter can never be silently dropped;
   *   * combined geographic levels are INTERSECTED, so a shallower level cannot
   *     widen a deeper one;
   *   * a scope that matches no shop matches nothing — never everything.
   *
   * @returns {{ scoped: boolean, shopFilter: object, ownerIds: string[]|null,
   *             applicationIds: string[]|null, applicationFilter: object }}
   */
  async resolveHierarchyScope(filters = {}) {
    return hierarchyScope.resolveHierarchyScope(filters);
  }

// -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  /**
   * Platform overview for the admin dashboard. Every number is real; where a
   * domain is unavailable the field is null and its name is listed in
   * `unavailable`, so the UI can say "not available" rather than showing a
   * misleading zero.
   */
  async getPlatformStats(filters = {}) {
    const unavailable = [];

    // Hierarchy filters scope the Commerce-owned counters (businesses, shops,
    // orders). Identity/Delivery aggregates are platform-wide by design and are
    // reported as such via `scopeApplied` + `scopeNote`.
    const scope = await this.resolveHierarchyScope(filters);

    const shopCountFilter = scope.shopFilter;
    const orderCountFilter = scope.scoped
      ? (scope.ownerIds.length
          ? { sellerId: scope.ownerIds.length === 1 ? scope.ownerIds[0] : { $in: scope.ownerIds } }
          : null)
      : {};
    const applicationCountFilter = scope.applicationFilter;

    // A scoped request with no matching seller must return honest zeros rather
    // than platform-wide totals.
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
      // Shops created before the status field existed have no status, so the
      // grouped counts alone would under-report the total. Count explicitly.
      shopRepo.count(shopCountFilter),
      shopRepo.count({ ...shopCountFilter, status: { $in: ['ACTIVE', 'APPROVED'] } }),
    ]);

    const applications = toCountMap(applicationCounts);
    const shops = toCountMap(shopCounts);
    const orders = toCountMap(orderStatusCounts);

    // Identity — platform user aggregates (cluster-credential internal route).
    const identity = await safe('identity users', identityClient.countUsers());
    if (!identity.ok) unavailable.push('users');

    // Delivery — physical pipeline + geographic coverage.
    const deliveryOps = await safe('delivery operations', deliveryClient.getInternalOperationsDashboard());
    if (!deliveryOps.ok) unavailable.push('deliveries');

    const locationCounts = await safe('delivery locations', deliveryClient.getInternalLocationCounts());
    if (!locationCounts.ok) unavailable.push('locations');

    const users = identity.ok ? identity.data.body.counts : null;
    const delivery = deliveryOps.ok ? deliveryOps.data.body.dashboard : null;
    const locations = locationCounts.ok ? locationCounts.data.body.counts : null;

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
        // Legacy rows with no status at all — surfaced instead of hidden.
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
        awaitingPickup: delivery ? delivery.byStatus.pending : null,
        inTransit: delivery ? delivery.byStatus.in_transit : null,
        exception: (orders['Refund Requested'] || 0) + (delivery ? delivery.byStatus.failed : 0),
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
        failedDeliveries: delivery ? delivery.byStatus.failed : null,
        total:
          (applications.PENDING_REVIEW || 0) +
          (shops.PENDING_APPROVAL || 0) +
          disputes.open,
      },
      unavailable,
      // The Commerce-owned counters above respect the hierarchy filter; the
      // Identity (users) and Delivery (deliveries/locations) aggregates do not,
      // so the UI can label them honestly instead of implying a scope.
      scopeApplied: scope.scoped,
      scopeNote: scope.scoped
        ? 'businesses, shops and orders are scoped to the selected hierarchy; users, deliveries and locations are platform-wide'
        : null,
      generatedAt: new Date().toISOString(),
    };
  }
/** Dispute counters (Commerce-owned collection). */
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

  /** Everything currently waiting on an admin decision, across domains. */
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
      ? (failedDeliveries.data.body.deliveries || []).map((delivery) => ({
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
// -------------------------------------------------------------------------
  // Platform Explorer (hierarchy)
  // -------------------------------------------------------------------------

  /**
   * Full Platform -> Region -> City -> Area -> Sector tree with rolled-up
   * Commerce metrics.
   *
   * Locations come from Delivery (owner of geography). Commerce metrics attach by:
   *   * shops      -> shop.locationId === location id (exact reference)
   *   * businesses -> seller application location names (region/city), matched
   *                   case-insensitively because onboarding stores free text
   *   * orders     -> orders.sellerId === shop.ownerId (order -> shop -> location)
   * Every collection is aggregated by the database; nothing is loaded wholesale.
   */
  async getHierarchy(filters = {}) {
    const { includeInactive = false } = filters;

    const hierarchyResult = await safe('delivery hierarchy', deliveryClient.getLocationHierarchy());
    if (!hierarchyResult.ok) {
      return {
        platform: await this.getPlatformTotalsForHierarchy(),
        regions: [],
        degraded: true,
        error: hierarchyResult.error,
      };
    }

    const rawRoots = Array.isArray(hierarchyResult.data.body.hierarchy)
      ? hierarchyResult.data.body.hierarchy
      : [];

    const [shopsByLocation, applicationsByRegion, applicationsByCity, ordersBySeller, shopsForOwners] =
      await Promise.all([
        shopRepo.countByField('locationId'),
        sellerAppRepo.countByField('location.region'),
        sellerAppRepo.countByField('location.city'),
        orderRepo.countByField('sellerId'),
        shopRepo.listOwnerLocationPairs(),
      ]);

    const shopLocationCounts = toCountMap(shopsByLocation);
    const businessRegionCounts = toCountMap(applicationsByRegion);
    const businessCityCounts = toCountMap(applicationsByCity);
    const sellerOrderCounts = toCountMap(ordersBySeller);

    // Attribute orders to a location through the shop that owns the seller.
    const ordersByLocation = {};
    for (const shop of shopsForOwners) {
      if (!shop.locationId || !shop.ownerId) continue;
      const orderCount = sellerOrderCounts[String(shop.ownerId)] || 0;
      if (!orderCount) continue;
      const key = String(shop.locationId);
      ordersByLocation[key] = (ordersByLocation[key] || 0) + orderCount;
    }

    const buildNode = (node) => {
      const id = String(node._id);
      const type = node.type;
      const isActive = node.isActive !== false;

      const direct = {
        shops: shopLocationCounts[id] || 0,
        orders: ordersByLocation[id] || 0,
        businesses: 0,
      };

      if (type === 'region') direct.businesses = businessRegionCounts[nameKey(node.name)] || 0;
      if (type === 'city') direct.businesses = businessCityCounts[nameKey(node.name)] || 0;

      const children = (node.children || [])
        .filter((child) => includeInactive || child.isActive !== false)
        .map(buildNode);

      const metrics = {
        shops: direct.shops,
        orders: direct.orders,
        businesses: direct.businesses,
        children: children.length,
        activeChildren: children.filter((child) => child.isActive).length,
      };

      for (const child of children) {
        metrics.shops += child.metrics.shops;
        metrics.orders += child.metrics.orders;
        metrics.businesses += child.metrics.businesses;
      }

      return { id, name: node.name, type, code: node.code || null, isActive, parentId: node.parentId || null, direct, metrics, children };
    };

    const regions = rawRoots
      .filter((root) => includeInactive || root.isActive !== false)
      .map(buildNode);

    return {
      platform: await this.getPlatformTotalsForHierarchy(),
      regions,
      levels: ['platform', 'region', 'city', 'area', 'sector'],
      generatedAt: new Date().toISOString(),
    };
  }

  /** Platform-level totals for the Explorer header (aggregated). */
  async getPlatformTotalsForHierarchy() {
    const [businesses, activeBusinesses, shops, activeShops, orders, sectors, activeSectors] =
      await Promise.all([
        sellerAppRepo.count({}),
        sellerAppRepo.count({ status: 'APPROVED' }),
        shopRepo.count({}),
        shopRepo.count({ status: { $in: ['ACTIVE', 'APPROVED'] } }),
        orderRepo.count({}),
        sectorRepo.count({}),
        sectorRepo.countActive(),
      ]);

    return {
      name: 'Platform',
      totals: { businesses, activeBusinesses, shops, activeShops, orders, sectors, activeSectors },
    };
  }
// -------------------------------------------------------------------------
  // Businesses (Seller/Business -> Shops)
  // -------------------------------------------------------------------------

  /** Paginated businesses with hierarchy filters (location / sector / status). */
  async getBusinesses(filters = {}) {
    const { status, search, page, limit } = filters;
    const { page: safePage, limit: safeLimit, skip } = paginate(page, limit);

    // Hierarchy filters (regionId/cityId/areaId/sectorId/businessId, plus the
    // legacy location/region/city/sector spellings) are normalised in one place.
    const scope = await this.resolveHierarchyScope(filters);

    const conditions = [];
    if (Object.keys(scope.applicationFilter).length) {
      conditions.push(scope.applicationFilter);
    }
    if (status) conditions.push({ status: String(status).toUpperCase() });
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      conditions.push({
        $or: [
          { 'businessInformation.businessName': rx },
          { 'businessInformation.email': rx },
          { ownerId: rx },
        ],
      });
    }

    const query = conditions.length > 1 ? { $and: conditions } : conditions[0] || {};

    const [businesses, total] = await Promise.all([
      sellerAppRepo.findAll(query, { skip, limit: safeLimit, sort: { createdAt: -1 } }),
      sellerAppRepo.count(query),
    ]);

    return {
      businesses: businesses.map((app) => this.toBusinessDto(app)),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
      scopeApplied: scope.scoped,
    };
  }

  toBusinessDto(app) {
    const info = app.businessInformation || {};
    const review = app.review || {};
    return {
      id: app._id,
      name: info.businessName || 'Seller application',
      ownerId: app.ownerId,
      owner: app.owner
        ? { id: app.owner.id || app.ownerId, name: app.owner.name || null, email: app.owner.email || null }
        : null,
      sellerType: app.sellerType,
      sector: info.businessCategory || null,
      status: app.status,
      email: info.email || null,
      phone: info.phone || null,
      location: app.location || null,
      shopId: app.shopId || null,
      shopCount: typeof app.shopCount === 'number' ? app.shopCount : undefined,
      verificationScore: typeof app.verificationScore === 'number' ? app.verificationScore : undefined,
      riskFlags: Array.isArray(app.riskFlags) ? app.riskFlags : undefined,
      submittedAt: app.submittedAt || null,
      createdAt: app.createdAt,
      reviewedBy: review.reviewedBy || null,
      reviewedByUser: review.reviewedByUser || null,
      reviewedAt: review.reviewedAt || null,
      rejectionReason: review.rejectionReason || null,
      timeline: Array.isArray(app.timeline) ? app.timeline : [],
    };
  }

  /**
   * Resolve an Identity user into a display-safe `{ name, email }` (or null).
   * Never fails the caller — owner UI must degrade to blank, not 500.
   */
  async resolveOwnerDisplay(ownerId) {
    if (!ownerId) return null;
    try {
      const res = await identityClient.findUser(String(ownerId));
      if (!res || res.status >= 400 || !res.body || !res.body.user) return null;
      const u = res.body.user;
      return { id: u.id || u._id || String(ownerId), name: u.name || null, email: u.email || null };
    } catch (e) {
      console.error('[resolveOwnerDisplay] identity lookup warning:', e.message);
      return null;
    }
  }

  /** Business detail + every shop it owns (Seller → Business → Shops). */
  async getBusinessDetail(applicationId) {
    const application = await sellerAppRepo.findById(applicationId);
    if (!application) {
      throw Object.assign(new Error('Business not found'), { status: 404 });
    }

    const shops = await shopRepo.findAll(
      {
        $or: [
          { businessId: String(applicationId) },
          { applicationId: String(applicationId) },
          ...(application.ownerId ? [{ ownerId: String(application.ownerId) }] : []),
        ],
      },
      { limit: 100 }
    );

    const shopIds = shops.map((s) => String(s._id));
    const [productCountRows, owner, orderCounts] = await Promise.all([
      shopIds.length ? productRepo.countByShops(shopIds) : Promise.resolve([]),
      this.resolveOwnerDisplay(application.ownerId),
      shopIds.length
        ? Promise.all(
            shopIds.map(async (id) => ({
              shopId: id,
              // Per-shop orders live on the shipment, not the order's sellerId
              // (which is the owner and would be identical for every shop).
              orders: await orderRepo
                .count({ 'sellerShipments.shopId': id })
                .catch(() => 0),
            }))
          )
        : Promise.resolve([]),
    ]);

    const productCounts = {};
    for (const row of productCountRows || []) {
      if (row && row._id != null) productCounts[String(row._id)] = row.count;
    }
    const ordersByShop = {};
    for (const entry of orderCounts) ordersByShop[entry.shopId] = entry.orders;

    const dto = this.toBusinessDto({ ...application.toObject?.() || application, owner });

    return {
      business: {
        ...dto,
        shopCount: shops.length,
        totalProducts: Object.values(productCounts).reduce((a, b) => a + b, 0),
        totalOrders: Object.values(ordersByShop).reduce((a, b) => a + b, 0),
      },
      shops: shops.map((shop) => ({
        id: shop._id,
        name: shop.name,
        email: shop.email,
        description: shop.description || '',
        status: shop.status,
        address: shop.address || '',
        locationSnapshot: shop.locationSnapshot || null,
        locationId: shop.locationId || null,
        sectorId: shop.sectorId || null,
        applicationId: shop.applicationId || null,
        showOnPublic: shop.showOnPublic !== false,
        productCount: productCounts[String(shop._id)] || 0,
        orders: ordersByShop[String(shop._id)] || 0,
        createdAt: shop.createdAt,
      })),
      shopCount: shops.length,
    };
  }

  // -------------------------------------------------------------------------
  // Shops
  // -------------------------------------------------------------------------

  /** Empty-but-scoped page: a filter that resolves to nothing must never widen. */
  emptyShopPage(page, limit) {
    return {
      shops: [],
      total: 0,
      page,
      limit,
      totalPages: 0,
      statusCounts: {},
      scopeApplied: true,
    };
  }

  /**
   * Resolve an owner EMAIL to an identity id so the admin list can filter on
   * it. An unknown email (or an Identity outage) answers "no match" — a filter
   * must never fall back to platform-wide rows.
   */
  async resolveOwnerByEmail(email) {
    try {
      const res = await identityClient.findUserByEmail(String(email).trim());
      if (!res || res.status >= 400 || !res.body || !res.body.user) return null;
      return String(res.body.user.id || res.body.user._id || '') || null;
    } catch (e) {
      console.error('[getShops] owner email lookup warning:', e.message);
      return null;
    }
  }

  /**
   * Expand an admin's free-text term into the PEOPLE and BUSINESSES it names.
   *
   * A shop is searched by what a human actually remembers — the owner's name,
   * phone or email, or the business name — and none of those live on the shop
   * document. They are resolved first and folded back into the query as ids, so
   * the search still ends in ONE shop query. A degraded Identity or business
   * lookup contributes nothing rather than failing the list: the shop's own
   * name / email / address / phone keep matching on their own.
   *
   * @returns {Promise<{ ownerIds: string[], applicationIds: string[] }>}
   */
  async expandOwnerSearch(search) {
    const term = String(search || '').trim();
    if (!term) return { ownerIds: [], applicationIds: [] };
    const rx = { $regex: escapeRegex(term), $options: 'i' };
    const [identityResult, applications] = await Promise.all([
      identityClient.searchUsers(term, 50),
      sellerAppRepo
        .findAll(
          { $or: [{ 'businessInformation.businessName': rx }, { 'shopInformation.shopName': rx }] },
          { limit: 100 }
        )
        .catch(() => []),
    ]);
    const ownerIds = identityClient
      .displayUsers(identityResult)
      .map((user) => String(user.id || user._id || ''))
      .filter(Boolean);
    const applicationIds = (applications || [])
      .map((app) => String(app._id || app.id || ''))
      .filter(Boolean);
    return { ownerIds, applicationIds };
  }

  /**
   * One batch pass that turns a page of foreign keys into display fields.
   *
   * Every admin row must show the human and the business behind it, never a
   * uuid. Identity and the seller-application store are each asked ONCE for the
   * whole page, and any outage degrades to blank names instead of a failed list.
   *
   * @returns {Promise<{ owners: Map<string, object>, businesses: Map<string, object> }>}
   */
  async hydrateOwnership(ownerIds = [], applicationIds = []) {
    const owners = new Map();
    const businesses = new Map();
    const uniqueOwners = [...new Set(ownerIds.filter(Boolean).map(String))];
    const uniqueApplications = [...new Set(applicationIds.filter(Boolean).map(String))];

    const [identityResult, applications] = await Promise.all([
      uniqueOwners.length ? identityClient.findUsersByIds(uniqueOwners) : Promise.resolve(null),
      uniqueApplications.length
        ? sellerAppRepo
            .findAll({ _id: { $in: uniqueApplications } }, { limit: uniqueApplications.length })
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    for (const user of identityClient.displayUsers(identityResult)) {
      const id = String(user.id || user._id || '');
      if (id) owners.set(id, user);
    }
    for (const app of applications || []) {
      const id = String(app._id || app.id || '');
      if (!id) continue;
      businesses.set(id, {
        id,
        name: (app.businessInformation && app.businessInformation.businessName) || app.name || null,
        status: app.status || null,
      });
    }
    return { owners, businesses };
  }

  async getShops(filters = {}) {
    const { status, search, page, limit } = filters;
    const { page: safePage, limit: safeLimit, skip } = paginate(page, limit);

    // Owner email lives in Identity, so it is resolved BEFORE the shop query.
    // It used to be forwarded and silently ignored — every value (including
    // bogus ones) returned the whole platform.
    const scopeFilters = { ...filters };
    if (filters.ownerEmail) {
      const ownerId = await this.resolveOwnerByEmail(filters.ownerEmail);
      if (!ownerId) return this.emptyShopPage(safePage, safeLimit);
      scopeFilters.ownerId = ownerId;
    }

    // The controller used to forward `location`/`sector` while this method read
    // `locationId`/`sectorId`, so those filters were always dropped. Both
    // spellings are now handled by the shared resolver.
    const scope = await this.resolveHierarchyScope(scopeFilters);

    const conditions = [];
    if (Object.keys(scope.shopFilter).length) conditions.push(scope.shopFilter);

    // Several sellers at once (the Sellers tab asks for exactly its page's
    // owners). One `ownerId` filter is the single-seller spelling of the same
    // thing and stays handled by the hierarchy scope above.
    const ownerIds = filters.ownerIds
      ? String(filters.ownerIds)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    // An explicitly empty batch is "the seller nobody", not "every seller".
    if (filters.ownerIds !== undefined && !ownerIds.length) return this.emptyShopPage(safePage, safeLimit);
    if (ownerIds.length) conditions.push({ ownerId: { $in: ownerIds } });

    // A businessId scopes shops through the seller's application link or owner.
    if (filters.businessId) {
      const applicationIds = scope.applicationIds || [];
      const ownerIds = scope.ownerIds || [];
      const businessOr = [
        ...(applicationIds.length ? [{ businessId: { $in: applicationIds } }] : []),
        ...(applicationIds.length ? [{ applicationId: { $in: applicationIds } }] : []),
        ...(ownerIds.length ? [{ ownerId: { $in: ownerIds } }] : []),
      ];
      if (!businessOr.length) return this.emptyShopPage(safePage, safeLimit);
      conditions.push({ $or: businessOr });
    }

    if (status) conditions.push({ status: String(status).toUpperCase() });
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      // The shop's own fields, plus the owner and the business the term names —
      // resolved to ids first so the search still costs ONE shop query.
      const { ownerIds, applicationIds } = await this.expandOwnerSearch(search);
      const ownerOr = [
        { name: rx },
        { email: rx },
        { address: rx },
        { phoneNumber: rx },
        ...(ownerIds.length ? [{ ownerId: { $in: ownerIds } }] : []),
        ...(applicationIds.length ? [{ businessId: { $in: applicationIds } }] : []),
        ...(applicationIds.length ? [{ applicationId: { $in: applicationIds } }] : []),
      ];
      conditions.push({ $or: ownerOr });
    }

    const query = conditions.length > 1 ? { $and: conditions } : conditions[0] || {};

    const [rawShops, total, statusCounts] = await Promise.all([
      shopRepo.findAll(query, { skip, limit: safeLimit, sort: { createdAt: -1 } }),
      shopRepo.count(query),
      // Scoped to the SAME query as the rows: the chips used to describe the
      // whole platform while the table showed a filtered page.
      shopRepo.countByField('status', query),
    ]);

    // Computed catalog stats (ratings/productCount) — same helpers the public
    // list uses, so the admin Rating column is never permanently empty.
    //
    // Ownership hydration runs in the SAME round: the console must show the
    // owner's name and the business behind every shop, never a raw `ownerId`,
    // and it must do it in one batch — not one Identity call per row.
    const plains = rawShops.map((doc) => (doc.toObject ? doc.toObject() : doc));
    const [productCounts, shopRatings, { owners, businesses }] = await Promise.all([
      computeProductCountsByShop().catch(() => new Map()),
      computeShopRatings().catch(() => new Map()),
      this.hydrateOwnership(
        plains.map((plain) => plain.ownerId),
        plains.map((plain) => plain.businessId || plain.applicationId)
      ),
    ]);

    const shops = plains.map((plain) => {
      const sid = String(plain._id);
      const owner = owners.get(String(plain.ownerId || '')) || null;
      const businessKey = plain.businessId || plain.applicationId;
      const business = businessKey ? businesses.get(String(businessKey)) || null : null;
      return {
        ...toAdminRow({
          ...plain,
          productCount: productCounts.get(sid) || plain.productCount,
          ratings: shopRatings.get(sid)?.ratings ?? plain.ratings,
          ratingCount: shopRatings.get(sid)?.ratingCount ?? plain.ratingCount,
        }),
        // Display-only: the ids stay authoritative, these are what a human reads.
        ownerName: owner ? owner.name || null : null,
        ownerEmail: owner ? owner.email || null : null,
        ownerPhoneNumber: owner ? owner.phoneNumber || null : null,
        businessName: business ? business.name : null,
        businessStatus: business ? business.status : null,
      };
    });

    return {
      shops,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
      statusCounts: toCountMap(statusCounts),
    };
  }
// -------------------------------------------------------------------------
  // Orders (commerce order + delivery lifecycle mapping)
  // -------------------------------------------------------------------------

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
      // Buyer snapshot the checkout recorded. Display-only projection: the name
      // and email a human reads, never the whole embedded object.
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
      // Full destination snapshot (historical, immutable)
      destination: order.destination || null,
      // Seller shipments with pickup locations. `businessId` MUST survive this
      // mapping — `hydrateOrderRows` resolves the business from it, and the
      // detail page prints the shop's business beside the shipment.
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
   *
   * An order is found by what is on screen or in someone's head: its id, the
   * buyer's name / email / phone, or the shop it came from. The buyer and shop
   * names do not live on the order document (only `buyerId` / `sellerId` and the
   * shipment ids do), so the term is resolved against Identity and the shop
   * store first and folded in as ids — the order query itself stays ONE query.
   *
   * @returns {Promise<object | null>} `null` when there is nothing to search for.
   */
  async buildOrderSearch(search) {
    const term = String(search || '').trim();
    if (!term) return null;
    const rx = new RegExp(escapeRegex(term), 'i');

    const clauses = [{ 'user.name': rx }, { 'user.email': rx }];
    // An admin pasting a full order id must land on exactly that order. Partial
    // ids cannot be matched against an ObjectId column, so only a complete id is
    // added here rather than a prefix scan over every order.
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
   *
   * The console must never show a bare `sellerId` / `shopId`, and it must not
   * fire one lookup per row either: the shop and business maps are built in one
   * batch pass, the buyer comes from the snapshot already on the order, and any
   * missing lookup simply leaves the display field blank instead of failing.
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
      this.hydrateOwnership(ownerIds, businessIds),
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
      // Per-shipment display fields: a route with several shops lists every one.
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
   *
   * The stage cannot be a database filter, so the response always states which
   * mode produced its numbers:
   *   * no stage filter — the page comes from the database and `stageCounts` is
   *     aggregated from order status across the WHOLE scoped set
   *     (`stageCountsScope: 'status'`);
   *   * stage filter — the scoped set is scanned in batches, mapped through the
   *     full lifecycle, filtered and then paged in memory, so `total` and
   *     `totalPages` describe the filtered set rather than the first page
   *     (`stageCountsScope: 'scan'`). `stageScanCapped: true` means the scan hit
   *     its cap, so the numbers may be incomplete — stated, never silent.
   */
  async getOrders(filters = {}) {
    const { sellerId, status, paymentStatus, stage, from, to, search, page, limit } = filters;
    const { page: safePage, limit: safeLimit, skip } = paginate(page, limit);

    const query = {};
    // Normalize before filtering, exactly like the analytics endpoint does.
    // A raw pass-through meant `?status=Delivered` missed every legacy
    // `DELIVERED` row, so the console's own order list and its status chart
    // could disagree about how many delivered orders exist.
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

    // A shop / business selection narrows the shipment itself. Resolving it
    // through the owning SELLER (which is what the hierarchy scope does) would
    // return every order that seller ever placed, not just this shop's — so the
    // precise predicate is applied on top of the owner scope, never instead of it.
    if (filters.shopId) query['sellerShipments.shopId'] = String(filters.shopId);
    if (filters.businessId) query['sellerShipments.businessId'] = String(filters.businessId);


    // Resolve every hierarchy filter spelling through the shops that own the
    // sellers. Region/city/area selections are expanded to their descendant
    // locations, because a shop stores a single leaf `locationId`.
    const scope = await this.resolveHierarchyScope(filters);
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

    // Free-text search: the term is resolved against the order's own snapshots
    // AND against the people and shops it names, then ANDed with every other
    // filter — so a search can never widen a scoped list.
    const searchFilter = await this.buildOrderSearch(search);
    if (searchFilter) Object.assign(query, searchFilter);

    if (scope.scoped) {
      if (!scope.ownerIds.length) return emptyResult;
      const sellerScope = scope.ownerIds.length === 1
        ? scope.ownerIds[0]
        : { $in: scope.ownerIds };
      // An explicit sellerId must still fall inside the hierarchy scope,
      // otherwise the two filters contradict each other.
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

      // Filter first, page second: the previous order paged in the database and
      // filtered afterwards, so a matching order on a later page was never
      // returned and `total` only described the first page.
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

    // One aggregation covers every matching order, so the counters are not
    // limited to the current page. They are status-derived, which the scope
    // label states.
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
   * Bulk delivery lookup for a bounded page of orders. A delivery-service
   * outage degrades to "no delivery data" rather than a failed request.
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

    // Only timestamps the platform actually records are emitted — the UI can
    // therefore tell "not reached yet" apart from "not tracked".
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

    // Ownership context for the detail page: which shop / business / seller this
    // order belongs to, and who the buyer is — as NAMES, in one batch pass, so
    // the console never has to print a raw id to identify an order.
    const shipments = Array.isArray(order.sellerShipments) ? order.sellerShipments : [];
    const shipmentShopIds = [...new Set(shipments.map((s) => s && s.shopId).filter(Boolean).map(String))];
    const shipmentBusinessIds = [...new Set(shipments.map((s) => s && s.businessId).filter(Boolean).map(String))];
    const [shopRows, { owners, businesses }] = await Promise.all([
      shipmentShopIds.length
        ? shopRepo.findAll({ _id: { $in: shipmentShopIds } }, { limit: shipmentShopIds.length }).catch(() => [])
        : Promise.resolve([]),
      this.hydrateOwnership([order.sellerId], shipmentBusinessIds),
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
        // Names for the console: never identify an order by a bare uuid.
        buyerName: (order.user && order.user.name) || null,
        buyerEmail: (order.user && order.user.email) || null,
        sellerName: seller ? seller.name || null : null,
        sellerEmail: seller ? seller.email || null : null,
        shopId: primaryShopId,
        shopName: lookupShopName(primaryShopId),
        businessId: primaryBusinessId,
        businessName: lookupBusinessName(primaryBusinessId),
        // Full destination snapshot (historical)
        destination: order.destination || null,
        // Seller shipments with pickup origins
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
// -------------------------------------------------------------------------
  // Business approvals (backend authority + audit; never frontend-only)
  // -------------------------------------------------------------------------

  /**
   * Approve a seller application. Only PENDING_REVIEW is approvable.
   *
   * DELEGATED to the canonical `sellerApplications.service.approve` so both
   * admin surfaces (`/admin/businesses/:id/approve` and
   * `/seller-application/:id/approve`) run the SAME code: Shop creation,
   * shopId linking, status timeline, audit, and the Identity role grant. The
   * historical duplicate implementation here approved the application WITHOUT
   * creating a shop, which left two accounts approved differently depending on
   * which endpoint an admin client called.
   */
  async approveBusiness(applicationId, adminId, adminNotes, adminName = 'Admin') {
    const application = await sellerAppRepo.findById(applicationId);
    if (!application) throw Object.assign(new Error('Business not found'), { status: 404 });

    const { application: approved } = await sellerApplicationsService.approve(
      String(applicationId),
      adminId || adminName
    );

    return this.toBusinessDto(approved);
  }

  /**
   * Reject a seller application. A reason is mandatory.
   *
   * DELEGATED to `sellerApplications.service.reject` for the same reason as
   * `approveBusiness` — one implementation of the review decision.
   */
  async rejectBusiness(applicationId, adminId, rejectionReason, adminName = 'Admin') {
    if (!rejectionReason) {
      throw Object.assign(new Error('A rejection reason is required'), { status: 400 });
    }

    const application = await sellerAppRepo.findById(applicationId);
    if (!application) throw Object.assign(new Error('Business not found'), { status: 404 });

    const rejected = await sellerApplicationsService.reject(
      String(applicationId),
      adminId || adminName,
      rejectionReason
    );

    return this.toBusinessDto(rejected);
  }

  /**
   * Audit sink. Every sensitive admin action lands in Identity's audit_logs
   * (schema: action, admin, target, previous/new value, reason, details, ip).
   */
  async logAuditAction(entry = {}) {
    if (!entry.action) return { ok: false, error: 'action is required' };
    const result = await sendAudit({ module: 'commerce', ...entry });
    return { ok: true, result };
  }
// -------------------------------------------------------------------------
  // Growth analytics (real historical data + explicit comparison period)
  // -------------------------------------------------------------------------

  /**
   * Time-bucketed growth by hierarchy level.
   *
   * Every figure is aggregated from the database; a bucket with no data reports
   * 0 and its comparison is `null` (never an invented percentage). `comparison`
   * documents exactly which previous window the deltas were measured against.
   */
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

    // Resolve every hierarchy filter spelling to the seller ids Commerce
    // orders/shops use. Region/city/area selections expand to their descendant
    // locations, so the analytics respect the same scope as the dashboards.
    const scope = await this.resolveHierarchyScope(filters);
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

    // Buckets with business/shop activity but no orders must still appear.
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

  // -------------------------------------------------------------------------
  // Live operations (Orders by real status — clickable and drillable)
  // -------------------------------------------------------------------------

  /**
   * Operational stage counters, combining Commerce order statuses with
   * Delivery's physical counters. A stage whose backing data is unavailable is
   * returned as null (never 0), and stages the platform cannot evidence are
   * listed in `unsupportedStages` instead of being shown as empty buckets.
   */
  async getOperationsOverview() {
    const [orderStatusCounts, settledDelivered] = await Promise.all([
      orderRepo.countByField('status'),
      orderRepo.count({ status: 'Delivered', paymentStatus: 'CONFIRMED' }),
    ]);

    // Counters use the SAME mapping as the drill-down lists, so a bucket can
    // never disagree with the rows behind it.
    const counts = {};
    for (const stage of lifecycle.OPERATIONAL_STAGES) counts[stage] = 0;
    for (const row of orderStatusCounts) {
      const stage = lifecycle.mapOrderStatusToStage(row._id);
      counts[stage] = (counts[stage] || 0) + row.count;
    }
    counts.completed = settledDelivered;

    const deliveryResult = await safe('delivery ops', deliveryClient.getInternalOperationsDashboard());
    const delivery = deliveryResult.ok ? deliveryResult.data.body.dashboard : null;

    // Physical movement is owned by Delivery: when its counters are available
    // they replace the order-level approximation for those stages.
    if (delivery) {
      // Physical movement is owned by Delivery: when its counters are available
      // they replace the order-level approximation for those stages.
      //
      // Read defensively, not blindly. `byStatus` is keyed by the delivery
      // service's canonical lifecycle, and a key read as `|| 0` is
      // indistinguishable from a genuinely empty bucket — which is how a stage
      // backed by a status this service had forgotten about silently reported 0.
      const byStatus = delivery.byStatus || {};
      const deliveryCount = (status) => {
        const value = byStatus[status];
        return Number.isFinite(value) ? value : null;
      };
      // `ready_for_pickup` is the delivery's READY POOL, which may be widened
      // beyond a single status (the ready pool and the in-progress group are the
      // delivery service's canonical groupings).
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
        // A stage the delivery service cannot evidence stays null, never 0.
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
          // The delivery service reports `providers`, not `actors`: reading a
          // key it never returns produced an always-undefined field that looked
          // like a real (and permanently zero) statistic.
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

module.exports = new AdminPlatformService();
module.exports.AdminPlatformService = AdminPlatformService;
module.exports.APPLICATION_STATUSES = APPLICATION_STATUSES;
module.exports.SHOP_STATUSES = SHOP_STATUSES;
module.exports.OPEN_DISPUTE_STATUSES = OPEN_DISPUTE_STATUSES;