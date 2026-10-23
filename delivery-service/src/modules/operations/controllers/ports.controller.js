const svc = require('../services/ports.service');
const locationsService = require('../../locations-expansion/services/locations.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const routesService = require('../../locations-expansion/services/routes.service');
const providersService = require('../../providers/services/providers.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

/**
 * Port relations are not stored on the Port document — they are derived:
 *   zones     -> Zone.locationIds contains the port's location, or Zone.portId
 *   routes    -> route origin / destination / waypoints include the location
 *   providers -> Provider.portId points at this port
 *
 * They are counted in ONE pass per page (not per port) so a full table stays
 * cheap, and every number is real data rather than a denormalised guess.
 */
async function buildRelations(ports) {
  if (ports.length === 0) return { zones: [], routes: [], providers: [], locations: [] };
  const locationIds = [...new Set(ports.map((h) => String(h.locationId)))];
  const portIds = ports.map((h) => String(h._id));

  const [zones, routes, providers, locations] = await Promise.all([
    zonesService.getZones({ $or: [{ locationIds: { $in: locationIds } }, { portId: { $in: portIds } }] }).catch(() => []),
    routesService.getRoutes({ $or: [
      { originLocationId: { $in: locationIds } },
      { destinationLocationId: { $in: locationIds } },
      { waypoints: { $in: locationIds } },
    ] }).catch(() => []),
    providersService.getProviders({ portId: { $in: portIds } }).catch(() => []),
    locationsService.getLocations({ _id: { $in: locationIds } }).catch(() => []),
  ]);

  return { zones, routes, providers, locations };
}

function enrich(port, rel) {
  const obj = port.toObject ? port.toObject() : port;
  const location = rel.locations.find((l) => String(l._id) === String(obj.locationId));
  const loc = String(obj.locationId);

  const zoneCount = rel.zones.filter((z) =>
    (z.locationIds || []).some((id) => String(id) === loc) || String(z.portId) === String(obj._id)).length;
  const routeCount = rel.routes.filter((r) =>
    String(r.originLocationId) === loc
    || String(r.destinationLocationId) === loc
    || (r.waypoints || []).some((w) => String(w) === loc)).length;
  const providerCount = rel.providers.filter((p) => String(p.portId) === String(obj._id)).length;

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

async function getPorts(req, res, next) {
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

    const [ports, total] = await Promise.all([
      svc.getPorts(filter, { skip, limit: safeLimit }),
      svc.countPorts(filter),
    ]);
    const rel = await buildRelations(ports);

    return ok(res, {
      ports: ports.map((h) => enrich(h, rel)),
      count: ports.length,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { return next(err); }
}

async function getPort(req, res, next) {
  try {
    const port = await svc.getPort(req.params.id);
    const [rel, providers] = await Promise.all([
      buildRelations([port]),
      providersService.getProviders({ portId: port._id }).catch(() => []),
    ]);
    return ok(res, {
      port: {
        ...enrich(port, rel),
        providers: providers.map((p) => ({
          _id: p._id, name: p.name, status: p.status, vehicleType: p.vehicleType, phone: p.phone,
        })),
      },
    });
  } catch (err) { return next(err); }
}

async function getPortStats(_req, res, next) {
  try {
    const all = await svc.getPorts({}, { limit: 200, skip: 0 });
    const rel = await buildRelations(all);
    return ok(res, {
      totalPorts: all.length,
      activePorts: all.filter((h) => h.status === 'active').length,
      inactivePorts: all.filter((h) => h.status === 'inactive').length,
      suspendedPorts: all.filter((h) => h.status === 'suspended').length,
      totalCapacity: all.reduce((sum, h) => sum + (h.capacity || 0), 0),
      currentLoad: all.reduce((sum, h) => sum + (h.currentLoad || 0), 0),
      withProviders: all.filter((h) => rel.providers.some((p) => String(p.portId) === String(h._id))).length,
    });
  } catch (err) { return next(err); }
}

async function createPort(req, res, next) {
  try {
    const port = await svc.createPort(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'HUB_CREATED', adminId, adminName, targetEntity: 'port', targetId: String(port._id), ipAddress });
    return created(res, { port }, 'Port created');
  } catch (err) { return next(err); }
}

async function updatePort(req, res, next) {
  try {
    const port = await svc.updatePort(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'HUB_UPDATED', adminId, adminName, targetEntity: 'port', targetId: req.params.id, ipAddress });
    return ok(res, { port }, 'Port updated');
  } catch (err) { return next(err); }
}

async function setPortStatus(req, res, next) {
  try {
    const { status } = req.body;
    const port = await svc.updatePort(req.params.id, { status });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'HUB_STATUS_CHANGED', level: 'WARNING', adminId, adminName,
      targetEntity: 'port', targetId: req.params.id, newValue: { status }, ipAddress,
    });
    return ok(res, { port }, 'Port status updated');
  } catch (err) { return next(err); }
}

async function getPublicPorts(req, res, next) {
  try {
    const { zoneId, locationId, status = 'active' } = req.query;
    const filter = { status };
    if (zoneId) filter.zoneId = zoneId;
    if (locationId) filter.locationId = locationId;
    const ports = await svc.getPorts(filter, { limit: 100 });
    return ok(res, {
      ports: ports.map((p) => ({
        _id: p._id,
        id: String(p._id),
        name: p.name,
        locationId: p.locationId,
        zoneId: p.zoneId,
        status: p.status,
        description: p.description,
        contactPhone: p.contactPhone,
        operatingHours: p.operatingHours,
      })),
      count: ports.length,
    });
  } catch (err) { return next(err); }
}

async function getPortsByZone(req, res, next) {
  try {
    const { zoneId } = req.params;
    const ports = await svc.getPorts({ zoneId, status: 'active' }, { limit: 100 });
    return ok(res, {
      ports: ports.map((p) => ({
        _id: p._id,
        id: String(p._id),
        name: p.name,
        locationId: p.locationId,
        zoneId: p.zoneId,
        status: p.status,
        description: p.description,
        contactPhone: p.contactPhone,
        operatingHours: p.operatingHours,
      })),
      count: ports.length,
    });
  } catch (err) { return next(err); }
}

module.exports = { getPorts, getPort, getPortStats, createPort, updatePort, setPortStatus, getPublicPorts, getPortsByZone };
