const shopRepository = require('../repositories/shops.repository');
const { findPublicAll } = require('../repositories/shops.public.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const sellerAppRepository = require('../repositories/sellerApplications.repository');
const { ensureBusiness, isLiveStatus } = require('./business.service');
const orderRepository = require('../../fulfillment/repositories/orders.repository');
const { identityClient } = require('../../../app/clients/identity.client');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const auditService = require('../../../shared/utils/audit-client');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const { validateCategory } = require('../../../shared/utils/categoryValidator');
const {
  isPubliclyVisible,
  toPublicShop,
  toAdminRow,
  countMapFromRows,
} = require('../shops.mapper');
const shopCoverageService = require('./shopCoverage.service');
const { publicDeliveryInfo } = shopCoverageService;

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/** The transition the admin console is allowed to make (single source of truth). */
const SHOP_STATUSES = ['ACTIVE', 'INACTIVE', 'PENDING_APPROVAL', 'SUSPENDED', 'APPROVED'];

/** Delivery location types a shop may point at. */
const SHOP_LOCATION_TYPES = ['region', 'city', 'area', 'sector', 'community'];
/** …and specifically what `sectorId` may point at. */
const SECTOR_TYPES = ['sector', 'community'];

function calculateShopRating(products) {
  const reviewRatings = [];
  for (const p of products) {
    for (const r of (p.reviews || [])) { if (r && r.rating) reviewRatings.push(r.rating); }
  }
  if (!reviewRatings.length) return { rating: 0, reviewCount: 0 };
  return { rating: reviewRatings.reduce((a, b) => a + b, 0) / reviewRatings.length, reviewCount: reviewRatings.length };
}

class ShopService {
  /** Resolve a shop for ownership middleware without applying public visibility rules. */
  async getShopById(id) {
    return shopRepository.findById(id);
  }

  /**
   * Create a shop for the CALLER's business.
   *
   * Ownership is derived from the verified identity — `ownerId`/`businessId`
   * in the body are ignored, so a seller can never open a shop under another
   * provision a new shop. An approved/active business is created directly as
   * APPROVED; sellers without that capability remain PENDING_APPROVAL.
   *
   * Location ids are validated against the Delivery hierarchy here (the update
   * path uses the same code), and the readable snapshot is rebuilt server-side
   * — a client may not author `locationSnapshot`.
   */
  async createShop(payload, requester) {
    if (!requester || !requester.id) throw new ApiError('Authentication required', 401);

    const { name, email, address, phoneNumber, zipCode, avatar, description, category } = payload;
    if (!avatar || !avatar.url) throw new ApiError('Please upload an avatar', 400);

    // Shop category (type 'business'). Optional on the FIRST shop so
    // onboarding never blocks on it, but a SENT value must be a real category —
    // and an ADDITIONAL shop must always carry one, because that is how a
    // business registers several stores under different shop categories.
    const shopCategory = category != null && String(category).trim() !== ''
      ? String(category).trim()
      : '';
    if (shopCategory) await validateCategory(shopCategory, 'business');

    // Seller-type rules (INDIVIDUAL vs BUSINESS).
    //  - INDIVIDUAL (or a seller with no application on file): exactly one shop.
    //  - BUSINESS: may own several shops, each with its own shop category.
    // The application is the only place sellerType is recorded; sellers
    // provisioned outside the application flow default to INDIVIDUAL, which is
    // the conservative side of the rule.
    const application = await sellerAppRepository.findByOwner(requester.id).catch(() => null);
    const sellerType = (application && application.sellerType) || 'INDIVIDUAL';
    // Identity owns seller capability/status; the gateway header only carries
    // the coarse role. Read the authoritative status before choosing the shop
    // lifecycle so an already-approved business does not have to send a new
    // shop through a redundant approval queue.
    let identityStatus = '';
    try {
      const statusResponse = await identityClient.getSellerStatus(requester.id);
      identityStatus = String(statusResponse?.body?.sellerStatus || '').toUpperCase();
    } catch (e) {
      console.error(`[createShop] seller status lookup warning for ${requester.id}: ${e.message}`);
    }
    const approvedSeller = ['APPROVED', 'ACTIVE', 'VERIFIED'].includes(identityStatus);
    const ownedShops = await shopRepository.find({ filter: { ownerId: requester.id } });
    const isAdditionalShop = ownedShops.length >= 1;

    // An approved/active business is the authoritative capability. Do not
    // re-apply the old sellerType gate to a shop created by an already-approved
    // business; legacy applications may be missing or carry INDIVIDUAL even
    // though Identity has granted the business capability.
    if (isAdditionalShop && sellerType !== 'BUSINESS' && !approvedSeller) {
      throw new ApiError(
        'Individual sellers can only operate one shop. Register as a business to open additional stores.',
        403
      );
    }
    if (isAdditionalShop && !shopCategory) {
      throw new ApiError(
        'A shop category is required when registering an additional shop, so each store is browsable on its own.',
        422
      );
    }

    const provided = [];
    if (payload.locationId !== undefined && payload.locationId !== null && payload.locationId !== '') provided.push('locationId');
    if (payload.sectorId !== undefined && payload.sectorId !== null && payload.sectorId !== '') provided.push('sectorId');

    const locationUpdate = await this.resolveLocationUpdate(
      { locationId: payload.locationId || null, sectorId: payload.sectorId || null },
      provided,
      { address, phoneNumber, coordinates: null }
    );

    const status = approvedSeller ? 'APPROVED' : 'PENDING_APPROVAL';

    // User -> Seller Actor -> BUSINESS -> Shop: a shop must never exist without
    // a business record. Sellers who reach here without a filed application get
    // a minimal one (flagged `provisionedFromShop`) so the hierarchy and the
    // admin business scope stay unbroken.
    const { business } = await ensureBusiness(requester.id, {
      businessName: String(name).trim(),
      businessCategory: shopCategory,
      email,
      shopName: String(name).trim(),
      live: isLiveStatus(status),
    });
    const businessId = String(business._id);

    const shop = await shopRepository.create({
      name: String(name).trim(),
      email,
      address,
      phoneNumber: String(phoneNumber ?? '').trim(),
      zipCode: zipCode != null && String(zipCode).trim() !== '' ? String(zipCode).trim() : '',
      description: description || undefined,
      category: shopCategory,
      avatar,
      ownerId: requester.id,
      status,
      applicationId: businessId,
      businessId,
      ...locationUpdate,
    });

    // Identity keeps its own `users.shop_id` pointer (best-effort, non-fatal).
    try {
      await identityClient.linkShopId(requester.id, String(shop._id));
    } catch (e) {
      console.error('[createShop] linkShopId warning:', e.message);
    }
    return shop;
  }

  /**
   * Shop detail with catalog stats (rating + product count, both computed).
   *
   * Visibility: ADMIN → full document; owner → full document; everyone else →
   * the public allowlist, and only when the shop is visible on the marketplace
   * (otherwise 404, exactly like the public detail route). This closes the
   * "any authenticated user can read any shop's balance/owner/email" hole
   * without taking the buyer's shop page down.
   */
  async getShopInfo(id, requester) {
    const shop = await shopRepository.findById(id);
    if (!shop) throw new ApiError('Business not found', 404);

    const isAdmin = Boolean(requester && requester.role === 'ADMIN');
    const isOwner = Boolean(requester && requester.id && String(shop.ownerId) === String(requester.id));

    if (!isAdmin && !isOwner) {
      if (!isPubliclyVisible(shop)) throw new ApiError('Shop not found', 404);
      return this.withCatalogStats(toPublicShop(shop));
    }
    return this.withCatalogStats(shop.toObject());
  }

  /** Adds the numbers every shop view needs — computed, never faked. */
  async withCatalogStats(shop) {
    const products = await productRepository.findByShop(String(shop._id));
    const rating = calculateShopRating(products);
    shop.ratings = rating.rating;
    shop.ratingCount = rating.reviewCount;
    shop.productCount = products.length;
    return shop;
  }

  /**
   * Admin shop detail: the shop plus the two joins the console needs to explain
   * it — its OWNER (Identity) and its BUSINESS (SellerApplication) — plus real
   * product/order counts. Cross-service reads degrade to null instead of
   * failing the page; product management itself stays in the Product module.
   */
  async getShopDetailForAdmin(id) {
    const shop = await this.getShopInfo(id, { role: 'ADMIN' });

    const ownerPromise = (async () => {
      try {
        const res = await identityClient.findUser(shop.ownerId);
        if (!res || res.status >= 400 || !res.body || !res.body.user) return null;
        const u = res.body.user;
        return {
          id: u.id || u._id || shop.ownerId,
          name: u.name || null,
          email: u.email || null,
          role: u.role || null,
          status: u.status || null,
        };
      } catch (e) {
        console.error('[getShopDetailForAdmin] owner lookup warning:', e.message);
        return null;
      }
    })();

    const applicationPromise = shop.applicationId
      ? sellerAppRepository.findById(shop.applicationId).catch(() => null)
      : Promise.resolve(null);

    const orderCountPromise = orderRepository
      .count({ 'sellerShipments.shopId': String(shop._id) })
      .catch(() => 0);

    const [owner, application, orderCount] = await Promise.all([
      ownerPromise,
      applicationPromise,
      orderCountPromise,
    ]);

    return {
      ...shop,
      owner,
      businessInformation: application ? (application.businessInformation || {}) : null,
      businessStatus: application ? (application.status || null) : null,
      applicationId: shop.applicationId || null,
      orderCount,
    };
  }

  /**
   * Validate shop location ids against the Delivery hierarchy and rebuild the
   * read-only `locationSnapshot`.
   *
   * @param {{locationId?: string|null, sectorId?: string|null}} effective ids the shop will hold AFTER this write
   * @param {Array<'locationId'|'sectorId'>} provided which ids came from the request (only those are validated/written)
   * @param {{address?: string, phoneNumber?: *, coordinates?: object}} context values copied into the snapshot
   * @returns {Promise<object>} update fragment (empty when nothing location-related changed)
   */
  async resolveLocationUpdate(effective, provided = [], context = {}) {
    if (!provided.length) return {};
    const update = {};

    if (provided.includes('locationId')) {
      await this.assertDeliveryLocation(effective.locationId, 'locationId', SHOP_LOCATION_TYPES);
      update.locationId = String(effective.locationId);
    }
    if (provided.includes('sectorId')) {
      await this.assertDeliveryLocation(effective.sectorId, 'sectorId', SECTOR_TYPES);
      update.sectorId = String(effective.sectorId);
    }

    const snapshot = await this.buildLocationSnapshot(effective, context);
    if (snapshot) update.locationSnapshot = snapshot;
    return update;
  }

  /**
   * One Delivery lookup that decides whether an id may be stored on a shop:
   * it must exist, be active, and be of an expected type.
   *
   * A transport failure answers 503 — never "valid": we do not accept a
   * location we could not verify.
   */
  async assertDeliveryLocation(id, field, allowedTypes) {
    if (!isValidObjectId(id)) throw new ApiError(`Invalid ${field}`, 400);

    let res;
    try {
      res = await deliveryClient.getLocation(String(id));
    } catch (e) {
      throw new ApiError('Location service is unavailable, please try again', 503);
    }
    if (!res || !res.status || res.status === 0 || res.status >= 500) {
      throw new ApiError('Location service is unavailable, please try again', 503);
    }
    const location = res.body && res.body.location;
    if (res.status === 404 || !location) throw new ApiError(`Unknown ${field}: no such location`, 400);
    if (location.isActive === false) throw new ApiError(`This ${field} is inactive`, 400);
    if (location.type && !allowedTypes.includes(location.type)) {
      throw new ApiError(`Invalid ${field}: expected one of ${allowedTypes.join(', ')} (got "${location.type}")`, 400);
    }
    return location;
  }

  /**
   * Build the readable Region → City → Sector snapshot for a shop by walking
   * the Delivery-owned hierarchy. Returns null when the path cannot be found
   * (Delivery down, or an id outside the tree) — orders then resolve it later
   * instead of trusting a half-built snapshot.
   */
  async buildLocationSnapshot(effective, context = {}) {
    const targetId = effective.sectorId || effective.locationId;
    if (!targetId) return null;

    let tree = null;
    try {
      const res = await deliveryClient.getLocationHierarchy();
      tree = res && res.body ? res.body.hierarchy : null;
    } catch (e) {
      tree = null;
    }
    if (!Array.isArray(tree)) return null;

    const path = this.findLocationPath(tree, String(targetId));
    if (!path) return null;

    const snapshot = {
      regionId: null, regionName: '',
      areaId: null, areaName: '',
      cityId: null, cityName: '',
      sectorId: null, sectorName: '',
      fullAddress: context.address || '',
      landmark: '',
      building: '',
      contactPhone: context.phoneNumber ? String(context.phoneNumber) : '',
      coordinates: {
        latitude: (context.coordinates && context.coordinates.latitude) || null,
        longitude: (context.coordinates && context.coordinates.longitude) || null,
      },
      resolvedAt: new Date(),
    };

    for (const step of path) {
      if (step.type === 'region') { snapshot.regionId = step.id; snapshot.regionName = step.name; }
      else if (step.type === 'city') { snapshot.cityId = step.id; snapshot.cityName = step.name; }
      else if (step.type === 'area') { snapshot.areaId = step.id; snapshot.areaName = step.name; }
      else if (step.type === 'sector' || step.type === 'community') {
        snapshot.sectorId = step.id; snapshot.sectorName = step.name;
      }
    }
    return snapshot;
  }

  /** Walk the (nested) Delivery hierarchy and return the path to `targetId`. */
  findLocationPath(tree, targetId) {
    const walk = (nodes, ancestors) => {
      for (const node of nodes || []) {
        const id = String(node._id || node.id || '');
        const path = [...ancestors, { id, name: node.name || '', type: node.type }];
        if (id === targetId) return path;
        const found = walk(node.children, path);
        if (found) return found;
      }
      return null;
    };
    return walk(tree, []);
  }

  /**
   * Resolve the shop owned by a user.
   *
   * Multi-step resolution:
   *   1. exact ownerId match (the canonical link),
   *   2. the value may itself be a shop id (legacy callers pass seller._id),
   *   3. SELF-HEAL by verified email: if the Identity store was rebuilt (fresh
   *      user ids) while Commerce kept the old `ownerId`, the authenticated
   *      email from the signed token re-links the shop instead of the seller
   *      being permanently locked out with a 404.
   */
  async getSellerShop(userId, email = null) {
    const shops = await shopRepository.find({ filter: { ownerId: userId } });
    if (shops.length > 0) return shops[0];

    // Fallback: look up by the shop's own _id, but only when the provided value
    // is a valid Mongo ObjectId. The identity-backed ownerId is a UUID string
    // (Postgres), which mongoose cannot cast to ObjectId — calling findById with
    // a UUID would throw a CastError (500). Non-sellers simply get null.
    if (isValidObjectId(userId)) {
      const byId = await shopRepository.findById(userId);
      if (byId && byId.ownerId === userId) return byId;
    }

    if (email) {
      const byEmail = await shopRepository.findByEmailInsensitive(String(email).trim());
      if (byEmail) {
        if (String(byEmail.ownerId) !== String(userId)) {
          try {
            await shopRepository.findByIdAndUpdate(byEmail._id, { ownerId: userId, updatedAt: new Date() });
            await identityClient.linkShopId(userId, String(byEmail._id));
            console.warn(`[getSellerShop] re-linked shop ${byEmail._id} to user ${userId} by verified email`);
          } catch (e) {
            console.error('[getSellerShop] re-link warning:', e.message);
          }
        }
        return byEmail;
      }
    }

    return null;
  }

  /**
   * EVERY shop of one business — the owner's shop list.
   *
   * Ordered oldest-first so the "primary" shop (the `seller` key in the
   * response, and the target when a write omits `shopId`) is stable. Product
   * counts come from ONE aggregation over the products collection.
   */
  async getSellerShops(userId, email = null) {
    const primary = await this.getSellerShop(userId, email); // keeps the verified-email self-heal
    if (!primary) return [];
    const shops = await shopRepository.find({ filter: { ownerId: userId }, sort: { createdAt: 1 } });
    if (!shops.length) return [primary.toObject ? primary.toObject() : primary];

    const rows = await productRepository.countByShops(shops.map((s) => String(s._id)));
    const counts = new Map(rows.map((r) => [String(r._id), r.count]));
    return shops.map((s) => {
      const plain = s.toObject();
      plain.productCount = counts.get(String(s._id)) || 0;
      return plain;
    });
  }

  /**
   * Resolve the shop a seller write is allowed to touch.
   *
   * `shopId` selects one of the CALLER's shops; a foreign id is a 403 (not a
   * 404 — the caller may not learn that the id exists). When `shopId` is
   * omitted it is only accepted if the caller owns exactly one shop, so a
   * multi-shop business can never have a request silently applied to the wrong
   * shop again.
   *
   * @param {{id: string, role?: string}} requester verified caller
   * @param {string} [shopId] shop id from the request body
   */
  async resolveOwnedShop(requester, shopId) {
    if (!requester || !requester.id) throw new ApiError('Authentication required', 401);

    const shops = await shopRepository.find({ filter: { ownerId: requester.id }, sort: { createdAt: 1 } });
    if (!shops.length) throw new ApiError('Business not found', 404);

    if (shopId !== undefined && shopId !== null && shopId !== '') {
      if (!isValidObjectId(shopId)) throw new ApiError('Invalid shop id', 400);
      const target = shops.find((s) => String(s._id) === String(shopId));
      if (!target) throw new ApiError('Forbidden: this shop does not belong to your business', 403);
      return target;
    }

    if (shops.length > 1) {
      throw new ApiError('shopId is required: your business owns more than one shop', 400);
    }
    return shops[0];
  }

  /**
   * The buyer-facing shop directory for an authenticated caller.
   *
   * Delegates to the PUBLIC repository: same visibility gate, same allowlisted
   * fields, same pagination as the guest endpoint. It used to hand every shop
   * document in full (owner ids, balances, hidden shops) to any logged-in user.
   */
  getAllShops(opts = {}) {
    const zoneId = opts.zoneId ? String(opts.zoneId) : null;
    // Same location-aware contract as the public list: eligibility filters are
    // applied in the repository and each shop carries its `delivery` block, so
    // a signed-in buyer's marketplace behaves exactly like the guest one.
    return findPublicAll(opts).then((result) => {
      result.shops = result.shops.map((shop) => ({
        ...shop,
        delivery: publicDeliveryInfo(shop, zoneId),
      }));
      return result;
    });
  }

  /**
   * Update the shop's logo. The target is resolved through
   * `resolveOwnedShop` by the controller, so this never touches a foreign shop.
   */
  async updateAvatar(shop, avatar) {
    if (!avatar || !avatar.url) throw new ApiError('Please upload an image', 400);
    const update = { avatar, updatedAt: new Date() };
    const updated = await shopRepository.updateOneById(shop._id, update);
    await this.syncShopSnapshot(shop._id, update);
    return updated;
  }

  /**
   * Seller-editable profile fields — an ALLOWLIST.
   *
   * Everything else on the Shops row is server- or admin-owned: `status`
   * (admin approval / rejection / suspension), `showOnPublic` (the admin
   * storefront toggle), `ownerId` (the identity link), `role`,
   * `applicationId`, `approvalMetadata`. The body used to be passed through
   * verbatim, so a seller could `PUT { status: 'APPROVED' }` to clear their
   * own suspension — and `status`/`showOnPublic` are exactly the two fields the
   * public product gate reads, so that also kept a rejected shop selling.
   */
  async updateInfo(shop, data) {
    const editable = [
      'name', 'description', 'email', 'address', 'phoneNumber', 'zipCode', 'category', 'pickupEnabled', 'pickupHours',
    ];
    const update = {};
    for (const key of editable) {
      if (data && data[key] !== undefined && data[key] !== null) update[key] = data[key];
    }
    if (update.name !== undefined) update.name = String(update.name).trim();
    if (update.phoneNumber !== undefined) update.phoneNumber = String(update.phoneNumber).trim();
    if (update.zipCode !== undefined) update.zipCode = String(update.zipCode).trim();
    if (update.pickupEnabled !== undefined && typeof update.pickupEnabled !== 'boolean') {
      throw Object.assign(new Error('pickupEnabled must be a boolean'), { statusCode: 422, code: 'VALIDATION_ERROR' });
    }
    if (update.pickupHours !== undefined) update.pickupHours = String(update.pickupHours).trim();
    if (update.category !== undefined) {
      update.category = String(update.category).trim();
      // A SENT category must exist as an active business category; empty clears it.
      if (update.category) await validateCategory(update.category, 'business');
    }

    // Location: ids are validated against Delivery and the snapshot is rebuilt
    // HERE — a client-supplied `locationSnapshot` is never written (it used to
    // be, which let an owner publish arbitrary region names into order origins).
    const provided = [];
    if (data && data.locationId !== undefined && data.locationId !== null && data.locationId !== '') {
      provided.push('locationId');
    }
    if (data && data.sectorId !== undefined && data.sectorId !== null && data.sectorId !== '') {
      provided.push('sectorId');
    }
    const locationUpdate = await this.resolveLocationUpdate(
      {
        locationId: provided.includes('locationId') ? data.locationId : (shop.locationId || null),
        sectorId: provided.includes('sectorId') ? data.sectorId : (shop.sectorId || null),
      },
      provided,
      {
        address: update.address !== undefined ? update.address : shop.address,
        phoneNumber: update.phoneNumber !== undefined ? update.phoneNumber : shop.phoneNumber,
        coordinates: shop.locationSnapshot && shop.locationSnapshot.coordinates,
      }
    );
    Object.assign(update, locationUpdate);

    if (!Object.keys(update).length) return shop; // body held nothing editable
    update.updatedAt = new Date();

    const updated = await shopRepository.updateOneById(shop._id, update);
    await this.syncShopSnapshot(shop._id, update);
    return updated;
  }

  /**
   * Mirror the shop row into the denormalised `shop` snapshot embedded on this
   * shop's products and events.
   *
   * Product cards render `shop.name` / `shop.avatar` straight from that
   * snapshot, and the PUBLIC product gate reads `shop.status` and
   * `shop.showOnPublic` from it. Without this sync a renamed shop keeps showing
   * its old name on every listing, and a suspended/rejected shop keeps its
   * products in front of buyers. (`showOnPublic` already cascaded; status,
   * name and avatar now do too.)
   */
  async syncShopSnapshot(id, fields) {
    // Only the fields the product payload actually carries. `ownerId` is
    // included because `getSellerShop` can re-link a shop to a new owner and
    // the embedded copy is what product cards and legacy readers show.
    const keys = ['name', 'avatar', 'email', 'phoneNumber', 'address', 'description', 'status', 'showOnPublic', 'ownerId'];
    const set = {};
    for (const key of keys) {
      if (fields && fields[key] !== undefined) set[`shop.${key}`] = fields[key];
    }
    if (!Object.keys(set).length) return;
    try {
      const Product = require('../../catalog/models/Products');
      const Event = require('../../promotions/models/Events');
      await Product.updateMany({ shopId: String(id) }, { $set: set });
      await Event.updateMany({ shopId: String(id) }, { $set: set });
    } catch (e) {
      console.error('[syncShopSnapshot] snapshot sync warning:', e.message);
    }
  }

  /**
   * Admin list. Pagination and BOTH counts are computed in the database and
   * scoped to the same filter — it used to load every shop into memory to
   * slice one page, and its status chips described the whole platform even
   * when the rows were filtered.
   */
  async listShopsAdmin(opts = {}) {
    const { status, search, limit = 20, offset = 0 } = opts;
    const filter = {};

    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { address: rx }];
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const [rawShops, total, statusCounts] = await Promise.all([
      shopRepository.findAll(filter, { skip: safeOffset, limit: safeLimit }),
      shopRepository.count(filter),
      shopRepository.countByField('status', filter),
    ]);

    // Same projection as GET /admin/shops (toAdminRow) so the pending queue
    // and any other admin list consumer share one field vocabulary.
    const shops = rawShops.map((s) => toAdminRow(s.toObject ? s.toObject() : s));

    return {
      shops,
      total,
      page: Math.floor(safeOffset / safeLimit) + 1,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
      statusCounts: countMapFromRows(statusCounts),
    };
  }

  /**
   * The ONLY place a shop's status changes (approve / reject / suspend /
   * activate all come through here).
   *
   * Besides the status it records who acted and why: the approve/reject reasons
   * used to be written to the audit log only, so the admin detail page could
   * never show `approvedAt` / `rejectionReason`. The status is also cascaded
   * into the embedded product snapshot so the public catalog reacts at once.
   */
  async updateShopStatus(id, status, adminId, meta = {}) {
    if (!SHOP_STATUSES.includes(status)) throw new ApiError('Invalid status', 400);

    const shop = await shopRepository.findById(id);
    if (!shop) throw new ApiError('Shop not found', 404);

    const oldStatus = shop.status;
    const now = new Date();
    const set = { status, updatedAt: now };

    if (status === 'APPROVED') {
      set['approvalMetadata.approvedBy'] = adminId || null;
      set['approvalMetadata.approvedAt'] = now;
      set['approvalMetadata.rejectionReason'] = null;
      set['approvalMetadata.suspensionReason'] = null;
    } else if (status === 'INACTIVE') {
      set['approvalMetadata.rejectionReason'] = meta.reason ? String(meta.reason) : null;
    } else if (status === 'SUSPENDED') {
      set['approvalMetadata.suspensionReason'] = meta.reason ? String(meta.reason) : null;
      set['approvalMetadata.suspendedBy'] = adminId || null;
      set['approvalMetadata.suspendedAt'] = now;
    }

    const updated = await shopRepository.findByIdAndUpdate(id, set, { new: true });
    // The public product gate reads the embedded snapshot — keep it in step so
    // suspending/rejecting a shop hides its products immediately.
    await this.syncShopSnapshot(id, { status });

    // Log status change to audit
    try {
      await auditService.logAction({
        action: 'SHOP_STATUS_CHANGED',
        adminId,
        targetUserId: shop.ownerId,
        details: {
          shopId: id,
          shopName: shop.name,
          oldStatus,
          newStatus: status,
          reason: meta.reason || null,
        },
        level: 'WARNING',
      });
    } catch (e) {
      console.error('[updateShopStatus] audit logging warning:', e.message);
    }

    return updated;
  }

  /**
   * ADMIN "allow in public" toggle for a shop — surfaced as an inline switch on
   * the existing Stores table (no dedicated page). `false` removes the shop
   * from every public view; the embedded shop snapshot on this shop's products
   * and events is kept in sync so the public filters cascade immediately
   * (legacy docs without the embedded flag stay visible — `$ne: false`).
   */
  async setShowOnPublic(id, showOnPublic) {
    const shop = await shopRepository.findById(id);
    if (!shop) throw new ApiError('Shop not found', 404);
    const value = showOnPublic !== false;
    const updated = await shopRepository.findByIdAndUpdate(
      id,
      { showOnPublic: value, updatedAt: new Date() },
      { new: true }
    );
    await this.syncShopSnapshot(id, { showOnPublic: value });
    return updated;
  }

  /** ADMIN: set a shop's delivery coverage (service areas). */
  async setCoverage(shopId, { zoneIds, status }, admin = {}) {
    return shopCoverageService.setCoverage(shopId, { zoneIds, status }, admin);
  }
}

module.exports = new ShopService();
