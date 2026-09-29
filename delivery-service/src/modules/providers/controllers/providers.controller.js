const svc = require('../services/providers.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const routesService = require('../../locations-expansion/services/routes.service');
const locationsService = require('../../locations-expansion/services/locations.service');
const assignmentsRepo = require('../../operations/repositories/assignmentBatches.repository');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const { ok, created } = require('../../../shared/utils/response');
const { isAdmin } = require('../../../shared/utils/access');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

// Providers that can be given new work. `pending` providers are not yet approved.
const ASSIGNABLE_PROVIDER_STATUSES = ['available', 'busy'];

async function createProvider(req, res, next) {
  try {
    const result = await svc.createProvider(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PROVIDER_CREATED', adminId, adminName, targetEntity: 'provider', targetId: result._id, ipAddress });
    return created(res, { provider: result }, 'Provider created');
  } catch (err) { return next(err); }
}

async function getProvider(req, res, next) {
  try { return ok(res, { provider: await svc.getProvider(req.params.id) }); }
  catch (err) { return next(err); }
}

async function updateProvider(req, res, next) {
  try {
    const result = await svc.updateProvider(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PROVIDER_UPDATED', adminId, adminName, targetEntity: 'provider', targetId: req.params.id, ipAddress });
    return ok(res, { provider: result }, 'Provider updated');
  } catch (err) { return next(err); }
}

async function getProviders(req, res, next) {
  try {
    const { status, serviceId, zoneId, sectorId, providerType, search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (serviceId) filter.serviceId = serviceId;
    if (zoneId) filter.zoneIds = zoneId;
    if (sectorId) filter.sectorId = sectorId;
    if (providerType) filter.providerType = providerType;
    // Availability filter is on the nested availability flag.
    if (req.query.isOnline === 'true') filter['availability.isOnline'] = true;
    if (req.query.isOnline === 'false') filter['availability.isOnline'] = false;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }, { plateNumber: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [providers, total] = await Promise.all([svc.getProviders(filter, { skip, limit: safeLimit }), svc.countProviders(filter)]);
    return ok(res, { providers, actors: providers, count: providers.length, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 });
  } catch (err) { return next(err); }
}

async function getAvailableProviders(req, res, next) {
  try { const p = await svc.getAvailableProviders(req.query.serviceId, req.query.zoneId); return ok(res, { providers: p, count: p.length }); }
  catch (err) { return next(err); }
}

async function setProviderStatus(req, res, next) {
  try {
    const result = await svc.setProviderStatus(req.params.id, req.body.status);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PROVIDER_STATUS_CHANGED', level: 'WARNING', adminId, adminName, targetEntity: 'provider', targetId: req.params.id, newValue: { status: req.body.status }, ipAddress });
    return ok(res, { provider: result }, 'Provider status updated');
  } catch (err) { return next(err); }
}

async function setOnline(req, res, next) {
  try {
    const provider = await svc.getProvider(req.params.id);
    if (req.user && !isAdmin(req.user) && provider.identityUserId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to update another provider' });
    }
    return ok(res, { provider: await svc.setOnline(req.params.id, req.body.isOnline, getAdminFromReq(req)) });
  } catch (err) { return next(err); }
}

async function updateLocation(req, res, next) {
  try {
    const provider = await svc.getProvider(req.params.id);
    if (req.user && !isAdmin(req.user) && provider.identityUserId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to update another provider' });
    }
    return ok(res, { provider: await svc.updateLocation(req.params.id, req.body.coordinates) });
  } catch (err) { return next(err); }
}

async function approveProvider(req, res, next) {
  try {
    // An approved provider must also hold the PROVIDER account role, otherwise
    // the provider workspace rejects them. Provision before flipping status so a
    // failed grant leaves the application still pending instead of half-approved.
    const provider = await svc.getProvider(req.params.id);
    const provisioning = await svc.provisionProviderAccount(provider);
    if (provisioning.blocking) {
      return res.status(502).json({
        success: false,
        code: 'PROVISIONING_FAILED',
        message: `Account provisioning failed: ${provisioning.reason || 'Identity Service unavailable'}`,
        errors: [],
      });
    }
    const result = await svc.approveProvider(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PROVIDER_APPROVED', adminId, adminName, targetEntity: 'provider', targetId: req.params.id, newValue: { status: 'available' }, ipAddress });
    return ok(res, { provider: result, provisioning }, 'Provider approved');
  } catch (err) { return next(err); }
}

/** Reject / suspend a provider with a reason. */
async function rejectProvider(req, res, next) {
  try {
    const reason = req.body.reason || 'Rejected by admin';
    // Delegates to the service so the admin route and the provider-application
    // review route share one rejection implementation (status + stored reason).
    const result = await svc.rejectProvider(req.params.id, reason, getAdminFromReq(req));
    return ok(res, { provider: result, reason });
  } catch (err) { return next(err); }
}

/**
 * Enriched provider detail for the admin workspace.
 *
 * Hydrates zones, routes, assignments and deliveries in a fixed number of
 * queries (not one-per-relation), so opening a provider stays cheap.
 */
async function getProviderDetail(req, res, next) {
  try {
    const provider = await svc.getProvider(req.params.id);
    const zoneIds = (provider.zoneIds || []).map(String);
    const [zones, routes, assignments, deliveries, location] = await Promise.all([
      zoneIds.length ? zonesService.getZones({ _id: { $in: zoneIds } }) : Promise.resolve([]),
      routesService.getRoutes({ providerId: provider._id }),
      assignmentsRepo.findAll({ providerId: provider._id }, { skip: 0, limit: 100 }),
      deliveriesRepo.findByProviderId(provider._id).catch(() => []),
      provider.sectorId ? locationsService.getLocation(provider.sectorId).catch(() => null) : Promise.resolve(null),
    ]);

    const activeAssignments = assignments.filter((a) =>
      ['waiting_acceptance', 'accepted', 'picking_up', 'picked_up', 'in_transit'].includes(a.status));

    return ok(res, {
      provider: {
        ...provider.toObject(),
        operatingLocationName: location ? location.name : null,
        zones,
        routes,
        assignments,
        activeAssignmentCount: activeAssignments.length,
        assignmentCount: assignments.length,
        deliveryCount: deliveries.length,
      },
    });
  } catch (err) { return next(err); }
}

/**
 * Replace the provider's assigned zones.
 * Only ACTIVE and SERVICEABLE zones may be assigned, per the product rule.
 */
async function assignZones(req, res, next) {
  try {
    const requested = [...new Set((req.body.zoneIds || []).map(String))];

    if (requested.length === 0) {
      const cleared = await svc.updateProvider(req.params.id, { zoneIds: [], zoneId: null });
      return ok(res, { provider: cleared, zones: [] }, 'All zones removed');
    }

    const zones = await zonesService.getZones({ _id: { $in: requested } });
    const found = new Set(zones.map((z) => String(z._id)));
    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw Object.assign(new Error(`Unknown zone(s): ${missing.join(', ')}`), { status: 400 });
    }

    const notAssignable = zones.filter(
      (z) => z.status !== 'active' || z.deliveryRules?.serviceable === false
    );
    if (notAssignable.length > 0) {
      const names = notAssignable.map((z) => {
        const why = z.status !== 'active' ? z.status : 'not serviceable';
        return `${z.name} (${why})`;
      });
      throw Object.assign(
        new Error(`Only active, serviceable zones can be assigned: ${names.join(', ')}`),
        { status: 400 }
      );
    }

    // Keep the legacy single `zoneId` in sync for the older assignment checks.
    const provider = await svc.updateProvider(req.params.id, { zoneIds: requested, zoneId: requested[0] });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PROVIDER_ZONES_ASSIGNED', adminId, adminName,
      targetEntity: 'provider', targetId: req.params.id, newValue: { zoneIds: requested }, ipAddress,
    });
    return ok(res, { provider, zones }, 'Zones assigned');
  } catch (err) { return next(err); }
}

/**
 * Replace the provider's assigned routes.
 *
 * A route holds a single `providerId`, so assigning a route here claims it and
 * takes it away from any previously assigned provider. An empty list releases
 * every route this provider currently holds.
 */
async function assignRoutes(req, res, next) {
  try {
    const requested = [...new Set((req.body.routeIds || []).map(String))];
    const provider = await svc.getProvider(req.params.id);
    const current = await routesService.getRoutes({ providerId: provider._id });

    if (requested.length === 0) {
      for (const r of current) await routesService.updateRoute(r._id, { providerId: null });
      return ok(res, { provider, routes: [] }, 'All routes removed');
    }

    const routes = await routesService.getRoutes({ _id: { $in: requested } });
    const found = new Set(routes.map((r) => String(r._id)));
    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw Object.assign(new Error(`Unknown route(s): ${missing.join(', ')}`), { status: 400 });
    }

    if (!ASSIGNABLE_PROVIDER_STATUSES.includes(provider.status)) {
      throw Object.assign(
        new Error(`Provider is ${provider.status} and cannot take routes`),
        { status: 400 }
      );
    }

    // Release routes no longer requested, then claim the new set.
    for (const r of current) {
      if (!requested.includes(String(r._id))) {
        await routesService.updateRoute(r._id, { providerId: null });
      }
    }
    for (const id of requested) {
      await routesService.updateRoute(id, { providerId: provider._id });
    }

    const updated = await routesService.getRoutes({ providerId: provider._id });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'PROVIDER_ROUTES_ASSIGNED', adminId, adminName,
      targetEntity: 'provider', targetId: req.params.id, newValue: { routeIds: requested }, ipAddress,
    });
    return ok(res, { provider, routes: updated }, 'Routes assigned');
  } catch (err) { return next(err); }
}

module.exports = {
  createProvider, getProvider, updateProvider, getProviders, getAvailableProviders,
  setProviderStatus, setOnline, updateLocation, approveProvider,
  rejectProvider, getProviderDetail, assignZones, assignRoutes,
};
