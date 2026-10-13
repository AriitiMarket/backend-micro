/**
 * ENHANCED: Hierarchy scope resolution with location-based admin scope
 * Complete implementation including all location hierarchy traversal
 */
const shopRepo = require('../../modules/selling/repositories/shops.repository');
const sellerAppRepo = require('../../modules/selling/repositories/sellerApplications.repository');
const { deliveryClient } = require('../../app/clients/delivery.client');
const { isValidObjectId } = require('./mongoId');

const HIERARCHY_FILTER_KEYS = [
  'regionId', 'cityId', 'areaId', 'sectorId', 'businessId', 'shopId', 'ownerId',
  'ownerEmail', 'locationId', 'location', 'region', 'city', 'sector',
  'area', 'business', 'shop', 'owner',
];

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

const MATCHES_NOTHING = { _id: { $in: [] } };

/**
 * ENHANCED: Load location hierarchy and build index
 * Returns map of: { parentId: [childIds...] }
 */
async function loadChildrenIndex() {
  try {
    const locations = await deliveryClient.getLocationHierarchy();
    if (!locations || !Array.isArray(locations)) return {};
    
    const index = {};
    for (const loc of locations) {
      if (loc.parentId) {
        if (!index[loc.parentId]) index[loc.parentId] = [];
        index[loc.parentId].push(loc.id);
      }
    }
    return index;
  } catch (err) {
    console.warn('[hierarchyScope] Failed to load location index:', err.message);
    return {};
  }
}

/**
 * ENHANCED: Recursively expand location to include all descendants
 * Used when admin selects a region to scope all sub-regions, cities, areas
 */
async function expandWithIndex(locationId, childrenIndex) {
  if (!locationId) return [];
  
  const expanded = [locationId];
  const queue = [locationId];
  
  while (queue.length) {
    const current = queue.shift();
    const children = childrenIndex[current] || [];
    
    for (const child of children) {
      if (!expanded.includes(child)) {
        expanded.push(child);
        queue.push(child);
      }
    }
  }
  
  return expanded;
}

/**
 * ENHANCED: Resolve hierarchy scope to database filters
 * Handles location hierarchy with intersection (narrowing, not widening)
 */
async function resolveHierarchyScope(filters = {}) {
  try {
    // 1. Build location hierarchy index
    const childrenIndex = await loadChildrenIndex();
    
    // 2. Expand all location selections
    const selectedLocations = [];
    for (const key of ['regionId', 'cityId', 'areaId', 'sectorId', 'locationId']) {
      if (filters[key]) {
        const expanded = await expandWithIndex(filters[key], childrenIndex);
        selectedLocations.push(expanded);
      }
    }
    
    // 3. Intersect all location selections (narrowing)
    let locationFilter = null;
    if (selectedLocations.length > 0) {
      locationFilter = selectedLocations.reduce((acc, current) => {
        if (!acc) return current;
        return acc.filter(id => current.includes(id));
      });
    }
    
    // 4. Build database query
    const query = {};
    
    // Location constraint
    if (locationFilter && locationFilter.length > 0) {
      query.locationId = { $in: locationFilter };
    } else if (selectedLocations.length > 0) {
      // Selections exist but intersection is empty
      return MATCHES_NOTHING;
    }
    
    // Business constraint
    if (filters.businessId) {
      if (!isValidObjectId(filters.businessId)) return MATCHES_NOTHING;
      query._id = filters.businessId; // For applications
    }
    
    // Shop constraint
    if (filters.shopId) {
      if (!isValidObjectId(filters.shopId)) return MATCHES_NOTHING;
      query._id = filters.shopId;
    }
    
    // Owner constraint
    if (filters.ownerId) {
      if (!isValidObjectId(filters.ownerId)) return MATCHES_NOTHING;
      query.ownerId = filters.ownerId;
    } else if (filters.ownerEmail) {
      const escaped = escapeRegex(filters.ownerEmail);
      query.email = { $regex: new RegExp(`^${escaped}$`, 'i') };
    }
    
    return query;
  } catch (err) {
    console.error('[hierarchyScope.resolveHierarchyScope]', err);
    return MATCHES_NOTHING;
  }
}

/**
 * ENHANCED: Get all location IDs that match a scope
 * Used for analytics aggregation
 */
async function expandLocationIds(locationIds = []) {
  if (!locationIds || locationIds.length === 0) return [];
  
  try {
    const childrenIndex = await loadChildrenIndex();
    const allIds = new Set();
    
    for (const locId of locationIds) {
      const expanded = await expandWithIndex(locId, childrenIndex);
      expanded.forEach(id => allIds.add(id));
    }
    
    return Array.from(allIds);
  } catch (err) {
    console.warn('[hierarchyScope.expandLocationIds]', err.message);
    return locationIds;
  }
}

/**
 * ENHANCED: Get analytics scoped by admin location hierarchy
 * Used by analytics service to aggregate data within admin scope
 */
async function getScopeAnalytics(scopeFilters) {
  try {
    const query = await resolveHierarchyScope(scopeFilters);
    
    if (query === MATCHES_NOTHING) {
      return { shops: 0, orders: 0, revenue: 0, sellers: 0 };
    }
    
    // Count shops matching scope
    const shopCount = await shopRepo.count(query);
    
    // Get owner IDs for this scope
    const owners = await shopRepo.distinct('ownerId', query);
    
    // Count orders from shops in scope
    const orderCount = await orderRepo.countByField('sellerId', { 
      sellerId: { $in: owners } 
    });
    
    // Calculate revenue
    const orders = await orderRepo.find({ sellerId: { $in: owners } });
    const revenue = orders.reduce((sum, order) => sum + (order.total || 0), 0);
    
    return {
      shops: shopCount,
      orders: orderCount,
      revenue,
      sellers: owners.length,
      scope: query
    };
  } catch (err) {
    console.error('[hierarchyScope.getScopeAnalytics]', err);
    return { shops: 0, orders: 0, revenue: 0, sellers: 0, error: err.message };
  }
}

module.exports = {
  HIERARCHY_FILTER_KEYS,
  pickHierarchyFilters,
  escapeRegex,
  MATCHES_NOTHING,
  loadChildrenIndex,
  expandWithIndex,
  resolveHierarchyScope,
  expandLocationIds,
  getScopeAnalytics,
};
