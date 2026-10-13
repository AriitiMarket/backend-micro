/**
 * Hierarchy scope resolution — the ONE place Commerce turns an admin hierarchy
 * selection into database filters.
 *
 * Consumed by the admin platform service and the analytics service, so a scope
 * can never mean two different things on two screens.
 *
 * Selection semantics (deliberately narrowing, never widening):
 *   * each selected geographic level (region/city/area/sector) is expanded to
 *     itself plus its descendants through the Delivery-owned location tree, and
 *     the expanded sets are INTERSECTED — selecting a region and a city inside it
 *     resolves to the city, not to the whole region;
 *   * a business selection constrains the shop query itself, so other sellers'
 *     shops cannot widen the result;
 *   * owners/applications are read with an indexed `distinct` instead of loading
 *     shop documents, so a large scope cannot silently stop narrowing at a cap;
 *   * a scope that matches no shop resolves to "matches nothing" rather than to
 *     "no filter" — a filter may never fall back to platform-wide data.
 */
const shopRepo = require('../../modules/selling/repositories/shops.repository');
const sellerAppRepo = require('../../modules/selling/repositories/sellerApplications.repository');
const { deliveryClient } = require('../../app/clients/delivery.client');
const { isValidObjectId } = require('./mongoId');

/** Every hierarchy filter spelling the admin console can send. */
const HIERARCHY_FILTER_KEYS = [
  'regionId', 'cityId', 'areaId', 'sectorId', 'businessId', 'shopId', 'ownerId',
  'ownerEmail',
  'locationId', 'location', 'region', 'city', 'sector',
  // Unambiguous short spellings of an ID. Accepting them means an older caller
  // that sends `shop`/`business`/`area` narrows the query instead of having the
  // filter silently dropped (which returned platform-wide rows for one shop).
  'area', 'business', 'shop', 'owner',
];

/** Picks the hierarchy keys out of a request query object. */
function pickHierarchyFilters(query = {}) {
  const filters = {};
  for (const key of HIERARCHY_FILTER_KEYS) {
    if (query[key] !== undefined && query[key] !== '') filters[key] = query[key];
  }
  return filters;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Nothing matches. Used so a scoped request never widens to everything. */
const MATCHES_NOTHING = { _id: { $in: [] } };

/** Fetches the Delivery-owned location tree once, as a parent -> children index. */
async function loadChildrenIndex() {
  let hierarchy = null;
  try {
    const res = await deliveryClient.getLocationHierarchy();
    hierarchy = res && res.body ? res.body.hierarchy : null;
  } catch {
    hierarchy = null;
  }
  if (!Array.isArray(hierarchy)) return null;

  const childrenByParent = new Map();
  const index = (nodes, parentId) => {
    for (const node of nodes || []) {
      const id = String(node.id || node._id || '');
      if (!id) continue;
      if (parentId) {
        if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
        childrenByParent.get(parentId).push(id);
      }
      index(node.children, id);
    }
  };
  index(hierarchy, null);
  return childrenByParent;
}

/**
 * Expands location ids to themselves plus every descendant id.
 * Falls back to the ids as given when the tree is unavailable, so a filter
 * degrades to "no wider than requested".
 */
async function expandLocationIds(ids) {
  const index = await loadChildrenIndex();
  return expandWithIndex(index, ids);
}

function expandWithIndex(index, ids) {
  if (!index) return [...new Set(ids.map(String))];
  const expanded = new Set();
  const walk = (id) => {
    if (expanded.has(id)) return;
    expanded.add(id);
    for (const child of index.get(id) || []) walk(child);
  };
  ids.forEach((id) => walk(String(id)));
  return [...expanded];
}

/**
 * Resolves a hierarchy selection into a Commerce scope.
 *
 * @returns {Promise<{ scoped: boolean, shopFilter: object,
 *   ownerIds: string[]|null, applicationIds: string[]|null,
 *   applicationFilter: object }>}
 */
async function resolveHierarchyScope(filters = {}) {
  const locationIds = [
    filters.areaId,
    filters.area,
    filters.cityId,
    filters.regionId,
    filters.locationId,
  ].filter(Boolean);
  const sectorId = filters.sectorId || null;
  const ownerId = filters.ownerId || filters.owner || null;
  const businessId = filters.businessId || filters.business || null;
  const shopId = filters.shopId || filters.shop || null;
  const locationText = filters.location || null;
  const regionText = filters.region || null;
  const cityText = filters.city || null;
  const sectorText = filters.sector || null;
  const hasTextFilter = Boolean(locationText || regionText || cityText || sectorText);

  const scoped = Boolean(
    locationIds.length || sectorId || businessId || shopId || ownerId || hasTextFilter
  );
  if (!scoped) {
    return {
      scoped: false,
      shopFilter: {},
      ownerIds: null,
      applicationIds: null,
      applicationFilter: {},
    };
  }

  const shopFilter = {};
  const applicationFilter = {};

  // An owner selection constrains the shop query itself, so the admin "owner"
  // filter can never be silently dropped (it used to be — every bogus value
  // returned the whole platform).
  if (ownerId) shopFilter.ownerId = String(ownerId);

  if (regionText) applicationFilter['location.region'] = new RegExp(`^${escapeRegex(regionText)}$`, 'i');
  if (cityText) applicationFilter['location.city'] = new RegExp(`^${escapeRegex(cityText)}$`, 'i');
  if (sectorText) applicationFilter.sellerType = sectorText;
  if (locationText && !regionText && !cityText) {
    const rx = new RegExp(escapeRegex(locationText), 'i');
    applicationFilter.$or = [
      { 'location.city': rx },
      { 'location.region': rx },
      { 'location.country': rx },
    ];
  }

  /**
   * The selection is scoped, but resolves to no shop at all — a malformed shop id,
   * contradictory geography, or a business with no shops. It must match NOTHING.
   * Falling back to platform-wide data here is what made a scope silently show
   * every seller's records.
   */
  const matchesNothing = () => ({
    scoped: true,
    shopFilter,
    ownerIds: [],
    applicationIds: [],
    applicationFilter: { ...applicationFilter, ...MATCHES_NOTHING, ownerId: { $in: [] } },
  });

  if (shopId) {
    // `_id` is an ObjectId: passing a non-ObjectId straight into the query raises
    // a CastError (surfaced as a 500) instead of answering "no match". A malformed
    // id is a scope that matches nothing, which is what the caller asked for.
    if (!isValidObjectId(shopId)) return matchesNothing();
    shopFilter._id = String(shopId);
  }
  if (sectorId) shopFilter.sectorId = String(sectorId);

  // Intersect the expanded sets so a shallower level never widens a deeper one.
  if (locationIds.length) {
    const index = await loadChildrenIndex();
    let intersection = null;
    for (const id of locationIds) {
      const set = new Set(expandWithIndex(index, [id]));
      intersection = intersection
        ? new Set([...intersection].filter((value) => set.has(value)))
        : set;
    }
    const ids = [...(intersection || [])];
    if (!ids.length) return matchesNothing();
    shopFilter.locationId = ids.length === 1 ? ids[0] : { $in: ids };
  }

  let ownerIds = null;
  let applicationIds = null;
  if (businessId) {
    // A business id is a SellerApplication _id. Before the hierarchy fix,
    // orders and seeds stored the owner's Identity *user id* here instead, so
    // a value that is not an ObjectId is still accepted as an owner id —
    // otherwise every legacy link would silently scope to nothing.
    if (isValidObjectId(businessId)) {
      const application = await sellerAppRepo.findById(businessId);
      applicationIds = [String(businessId)];
      ownerIds = application && application.ownerId ? [String(application.ownerId)] : [];
    } else {
      applicationIds = [];
      ownerIds = [String(businessId)];
    }
    // Constrain the shop query itself: without this, shops belonging to other
    // sellers would re-introduce owners outside the selected business.
    const businessOr = [
      ...(applicationIds.length ? [{ businessId: { $in: applicationIds } }] : []),
      ...(applicationIds.length ? [{ applicationId: { $in: applicationIds } }] : []),
      ...(ownerIds.length ? [{ ownerId: { $in: ownerIds } }] : []),
    ];
    if (!businessOr.length) return matchesNothing();
    shopFilter.$or = businessOr;
  }

  const distinctIds = (field) =>
    shopRepo.distinct(field, shopFilter).then((rows) => rows.filter(Boolean).map(String));

  const shopOwnerIds = await distinctIds('ownerId');
  const shopApplicationIds = new Set(await distinctIds('applicationId'));
  const shopBusinessIds = new Set(await distinctIds('businessId'));

  if (businessId) {
    // Intersection, not union: keep only what the business itself owns.
    ownerIds = ownerIds.filter((id) => shopOwnerIds.includes(id));
    applicationIds = applicationIds.filter(
      (id) => shopApplicationIds.has(id) || shopBusinessIds.has(id)
    );
    if (!ownerIds.length && !applicationIds.length) return matchesNothing();
  } else {
    ownerIds = shopOwnerIds;
    applicationIds = [...new Set([...shopApplicationIds, ...shopBusinessIds])];
  }

  if (ownerIds.length) {
    applicationFilter.ownerId = { $in: ownerIds };
  } else if (!hasTextFilter) {
    // The scope matched no shop: match nothing rather than everything.
    applicationFilter.ownerId = { $in: [] };
    applicationFilter._id = MATCHES_NOTHING._id;
  }

  return { scoped: true, shopFilter, ownerIds, applicationIds, applicationFilter };
}

module.exports = {
  HIERARCHY_FILTER_KEYS,
  MATCHES_NOTHING,
  pickHierarchyFilters,
  expandLocationIds,
  resolveHierarchyScope,
};
