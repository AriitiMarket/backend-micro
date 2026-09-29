/**
 * Location Resolution Service
 * Fetches delivery-service locations and coordinates with commerce data
 *
 * Modern modular design:
 * - Separation of concerns (fetch vs link vs validate)
 * - Reusable resolver functions
 * - No side effects until explicit commit
 *
 * Talks to the Delivery Service DIRECTLY over the private network
 * (DELIVERY_SERVICE_URL) through the shared internal client — no gateway hop.
 * This module previously used the built-in `fetch` against API_GATEWAY_URL; the
 * built-in fetch is still avoided for inter-service traffic because it has no
 * cluster credential, no retry policy and no structured logging, which is
 * exactly what the internal client provides.
 */

const { deliveryClientInternals } = require('../../app/clients/delivery.client');

/**
 * Map the historical public paths used in this module onto Delivery's INTERNAL
 * surface: `/api/delivery/location/...` -> `/internal/delivery/location/...`.
 * The `/api` prefix belonged to the gateway hop, and a peer service is refused on
 * user-facing routes, so the internal namespace is the only correct target.
 */
function normalizePath(path) {
  const value = String(path == null ? '' : path);
  return value
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/^\/delivery\//, '/internal/delivery/') || '/';
}

/** GET + JSON with a 5s ceiling. Throws on failure, as callers already expect. */
async function getJson(path, params) {
  const res = await deliveryClientInternals.request('GET', normalizePath(path), {
    query: params,
    timeoutMs: 5000,
  });
  if (!res.ok) throw new Error(res.error || ('HTTP ' + res.status));
  return res.body;
}

/**
 * Fetch location hierarchy from delivery-service
 */
async function fetchLocationHierarchy() {
  try {
    const data = await getJson('/api/delivery/location/hierarchy');
    return data.hierarchy || [];
  } catch (err) {
    console.error('[locationResolver] Failed to fetch hierarchy:', err.message);
    return [];
  }
}

/**
 * Find location by name and type
 */
async function findLocationByNameAndType(name, type) {
  try {
    const data = await getJson('/api/delivery/location/search', { q: name });
    const locations = data.locations || [];
    return locations.find(loc =>
      loc.name.toLowerCase() === name.toLowerCase() && loc.type === type
    ) || null;
  } catch (err) {
    console.error('[locationResolver] Search failed:', err.message);
    return null;
  }
}

/**
 * Get locations by type (e.g., all sectors)
 */
async function getLocationsByType(type) {
  try {
    const data = await getJson('/api/delivery/location', { type });
    return data.locations || [];
  } catch (err) {
    console.error('[locationResolver] Get by type failed:', err.message);
    return [];
  }
}

/**
 * Get location with full path (ancestors)
 */
async function getLocationWithPath(locationId) {
  try {
    const [location, ancestors] = await Promise.all([
      getJson(`/api/delivery/location/${locationId}`),
      getJson(`/api/delivery/location/${locationId}/ancestors`),
    ]);

    return {
      location: location.location,
      ancestors: ancestors.ancestors || [],
    };
  } catch (err) {
    console.error('[locationResolver] Get with path failed:', err.message);
    return { location: null, ancestors: [] };
  }
}

/**
 * Resolve shop location from sector
 * Maps: Sector → Area → City → Region
 */
async function resolveShopLocation(sectorId) {
  const { location, ancestors } = await getLocationWithPath(sectorId);

  if (!location) return null;

  const locationMap = {
    type: location.type,
    sectorId: location._id.toString(),
    sectorName: location.name,
  };

  // Build path from ancestors
  for (const ancestor of ancestors) {
    if (ancestor.type === 'area') {
      locationMap.areaId = ancestor._id.toString();
      locationMap.areaName = ancestor.name;
    } else if (ancestor.type === 'city') {
      locationMap.cityId = ancestor._id.toString();
      locationMap.cityName = ancestor.name;
    } else if (ancestor.type === 'region') {
      locationMap.regionId = ancestor._id.toString();
      locationMap.regionName = ancestor.name;
    }
  }

  return locationMap;
}

/**
 * Get all harar sectors
 */
async function getHarariSectors() {
  try {
    // Find Harar city
    const harariCity = await findLocationByNameAndType('Harar', 'city');
    if (!harariCity) {
      console.warn('[locationResolver] Harar city not found');
      return [];
    }

    // Get all sectors in Harar
    const data = await getJson(`/api/delivery/location/${harariCity._id}/children`);
    const areas = data.children || [];
    const sectors = [];

    for (const area of areas) {
      const areaChildren = await getJson(`/api/delivery/location/${area._id}/children`);
      sectors.push(...(areaChildren.children || []));
    }

    return sectors;
  } catch (err) {
    console.error('[locationResolver] Get Harar sectors failed:', err.message);
    return [];
  }
}

module.exports = {
  fetchLocationHierarchy,
  findLocationByNameAndType,
  getLocationsByType,
  getLocationWithPath,
  resolveShopLocation,
  getHarariSectors,
};
