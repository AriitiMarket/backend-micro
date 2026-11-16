'use strict';

/**
 * Admin Businesses & Shops Service
 * Handles business onboarding applications, approval/rejection decisions,
 * shop administration, and cross-service owner identity hydration.
 */

const shopRepo = require('../../selling/repositories/shops.repository');
const { toAdminRow } = require('../../selling/shops.mapper');
const {
  computeProductCountsByShop,
  computeShopRatings,
} = require('../../selling/repositories/shops.public.repository');
const sellerAppRepo = require('../../selling/repositories/sellerApplications.repository');
const sellerApplicationsService = require('../../selling/services/sellerApplications.service');
const orderRepo = require('../../orders/repositories/orders.repository');
const productRepo = require('../../catalog/repositories/products.repository');
const { identityClient } = require('../../../app/clients/identity.client');
const adminHierarchyService = require('./adminHierarchy.service');

function paginate(page, limit, defaults = { page: 1, limit: 50, maxLimit: 200 }) {
  const safePage = Math.max(parseInt(page, 10) || defaults.page, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || defaults.limit, 1), defaults.maxLimit);
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toCountMap(rows) {
  const out = {};
  for (const row of rows) {
    if (row && row._id !== null && row._id !== undefined) out[String(row._id)] = row.count;
  }
  return out;
}

class AdminBusinessesService {
  async getBusinesses(filters = {}) {
    const { status, search, page, limit } = filters;
    const { page: safePage, limit: safeLimit, skip } = paginate(page, limit);

    const scope = await adminHierarchyService.resolveHierarchyScope(filters);

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

    const scopeFilters = { ...filters };
    if (filters.ownerEmail) {
      const ownerId = await this.resolveOwnerByEmail(filters.ownerEmail);
      if (!ownerId) return this.emptyShopPage(safePage, safeLimit);
      scopeFilters.ownerId = ownerId;
    }

    const scope = await adminHierarchyService.resolveHierarchyScope(scopeFilters);

    const conditions = [];
    if (Object.keys(scope.shopFilter).length) conditions.push(scope.shopFilter);

    const ownerIds = filters.ownerIds
      ? String(filters.ownerIds)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    if (filters.ownerIds !== undefined && !ownerIds.length) return this.emptyShopPage(safePage, safeLimit);
    if (ownerIds.length) conditions.push({ ownerId: { $in: ownerIds } });

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
      shopRepo.countByField('status', query),
    ]);

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

  async approveBusiness(applicationId, adminId, adminNotes, adminName = 'Admin') {
    const application = await sellerAppRepo.findById(applicationId);
    if (!application) throw Object.assign(new Error('Business not found'), { status: 404 });

    const { application: approved } = await sellerApplicationsService.approve(
      String(applicationId),
      adminId || adminName
    );

    return this.toBusinessDto(approved);
  }

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
}

module.exports = new AdminBusinessesService();
