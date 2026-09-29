const svc = require('../services/hubs.service');
const locationsService = require('../../locations-expansion/services/locations.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const routesService = require('../../locations-expansion/services/routes.service');
const providersService = require('../../providers/services/providers.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

/**
 * Hub relations are not stored on the Hub document — they are derived:
 *   zones     -> Zone.locationIds contains the hub's location, or Zone.hubId
 *   routes    -> route origin / destination / waypoints include the location
 *   providers -> Provider.hubId points at this hub
 *
 * They are counted in ONE pass per page (not per hub) so a full table stays
 * cheap, and every number is real data rather than a denormalised guess.
 */
async function buildRelations(hubs) {
  if (hubs.length === 0) return { zones: [], routes: [], providers: [], locations: [] };
  const locationIds = [...new Set(hubs.map((h) => String(h.locationId)))];
  const hubIds = hubs.map((h) => String(h._id));

  const [zones, routes, providers, locations] = await Promise.all([
    zonesService.getZones({ $or: [{ locationIds: { $in: locationIds } }, { hubId: { $in: hubIds } }] }).catch(() => []),
    routesService.getRoutes({ $or: [
      { originLocationId: { $in: locationIds } },
      { destinationLocationId: { $in: locationIds } },
      { waypoints: { $in: locationIds } },
    ] }).catch(() => []),
    providersService.getProviders({ hubId: { $in: hubIds } }).catch(() => []),
    locationsService.getLocations({ _id: { $in: locationIds } }).catch(() => []),
  ]);

  return { zones, routes, providers, locations };
}

function enrich(hub, rel) {
  const obj = hub.toObject ? hub.toObject() : hub;
  const location = rel.locations.find((l) => String(l._id) === String(obj.locationId));
  const loc = String(obj.locationId);

  const zoneCount = rel.zones.filter((z) =>
    (z.locationIds || []).some((id) => String(id) === loc) || String(z.hubId) === String(obj._id)).length;
  const routeCount = rel.routes.filter((r) =>
    String(r.originLocationId) === loc
    || String(r.destinationLocationId) === loc
    || (r.waypoints || []).some((w) => String(w) === loc)).length;
  const providerCount = rel.providers.filter((p) => String(p.hubId) === String(obj._id)).length;

  return {
    ...obj,
    id: String(obj._id),
    locationName: location ? location.name : null,
    locationType: location ? location.type : null,
    zoneCount,
    routeCount,
    providerCount,
  };
}

async function getHubs(req, res, next) {
  try {
    const { status, locationId, search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (locationId) filter.locationId = locationId;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { description: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;

    const [hubs, total] = await Promise.all([
      svc.getHubs(filter, { skip, limit: safeLimit }),
      svc.countHubs(filter),
    ]);
    const rel = await buildRelations(hubs);

    return ok(res, {
      hubs: hubs.map((h) => enrich(h, rel)),
      count: hubs.length,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { return next(err); }
}

async function getHub(req, res, next) {
  try {
    const hub = await svc.getHub(req.params.id);
    const [rel, providers] = await Promise.all([
      buildRelations([hub]),
      providersService.getProviders({ hubId: hub._id }).catch(() => []),
    ]);
    return ok(res, {
      hub: {
        ...enrich(hub, rel),
        providers: providers.map((p) => ({
          _id: p._id, name: p.name, status: p.status, vehicleType: p.vehicleType, phone: p.phone,
        })),
      },
    });
  } catch (err) { return next(err); }
}

async function getHubStats(_req, res, next) {
  try {
    const all = await svc.getHubs({}, { limit: 200, skip: 0 });
    const rel = await buildRelations(all);
    return ok(res, {
      totalHubs: all.length,
      activeHubs: all.filter((h) => h.status === 'active').length,
      inactiveHubs: all.filter((h) => h.status === 'inactive').length,
      suspendedHubs: all.filter((h) => h.status === 'suspended').length,
      totalCapacity: all.reduce((sum, h) => sum + (h.capacity || 0), 0),
      currentLoad: all.reduce((sum, h) => sum + (h.currentLoad || 0), 0),
      withProviders: all.filter((h) => rel.providers.some((p) => String(p.hubId) === String(h._id))).length,
    });
  } catch (err) { return next(err); }
}

async function createHub(req, res, next) {
  try {
    const hub = await svc.createHub(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'HUB_CREATED', adminId, adminName, targetEntity: 'hub', targetId: String(hub._id), ipAddress });
    return created(res, { hub }, 'Hub created');
  } catch (err) { return next(err); }
}

async function updateHub(req, res, next) {
  try {
    const hub = await svc.updateHub(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'HUB_UPDATED', adminId, adminName, targetEntity: 'hub', targetId: req.params.id, ipAddress });
    return ok(res, { hub }, 'Hub updated');
  } catch (err) { return next(err); }
}

async function setHubStatus(req, res, next) {
  try {
    const { status } = req.body;
    const hub = await svc.updateHub(req.params.id, { status });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'HUB_STATUS_CHANGED', level: 'WARNING', adminId, adminName,
      targetEntity: 'hub', targetId: req.params.id, newValue: { status }, ipAddress,
    });
    return ok(res, { hub }, 'Hub status updated');
  } catch (err) { return next(err); }
}

module.exports = { getHubs, getHub, getHubStats, createHub, updateHub, setHubStatus };
