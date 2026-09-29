const svc = require('../services/assignments.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const providersRepo = require('../../providers/repositories/providers.repository');
const providersService = require('../../providers/services/providers.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const { ok, created } = require('../../../shared/utils/response');
const { forbidden, notFound } = require('../../../shared/errors');
const {
  isAdmin, isOperator, resolveProviderForUser, assertCanReadDelivery,
} = require('../../../shared/utils/access');

async function createAssignment(req, res, next) {
  try {
    // Accept either deliveryId or the commerce/admin alias
    const body = { ...req.body };
    if (!body.deliveryId && body.deliveryRequestId) body.deliveryId = body.deliveryRequestId;
    return created(res, { assignment: await svc.createAssignment(body) }, 'Assignment created');
  } catch (err) { return next(err); }
}

async function automaticAssignment(req, res, next) {
  try {
    const deliveryId = req.body.deliveryId || req.body.deliveryRequestId;
    return created(res, { assignment: await svc.automaticAssignment(deliveryId) }, 'Automatic assignment completed');
  } catch (err) { return next(err); }
}

async function getAssignment(req, res, next) {
  try {
    const assignment = await svc.getAssignment(req.params.id);
    // Admin sees all; a rider sees only its own; sellers/buyers go through
    // the delivery they own (assignment history is part of that delivery).
    if (!isAdmin(req.user)) {
      if (isOperator(req.user)) {
        const provider = await resolveProviderForUser(req.user);
        if (!provider || String(assignment.providerId) !== String(provider._id)) {
          return next(forbidden('You can only access your assigned deliveries'));
        }
      } else {
        const delivery = await deliveriesRepo.findById(assignment.deliveryId);
        await assertCanReadDelivery(delivery, req.user);
      }
    }
    return ok(res, { assignment });
  }
  catch (err) { return next(err); }
}

async function respondToAssignment(req, res, next) {
  try {
    // The rider identity user id is NOT the Provider _id on the assignment —
    // resolve the Provider first, otherwise ownership can never match.
    const provider = await providersRepo.findByIdentityUserId(req.user && req.user.id);
    if (!provider) return next(forbidden('No delivery provider profile for this account'));
    const result = await svc.respondToAssignment(req.params.id, req.body.accepted, provider._id);
    return ok(res, { assignment: result }, req.body.accepted ? 'Accepted' : 'Rejected');
  } catch (err) { return next(err); }
}

async function reassign(req, res, next) {
  // `partnerId` is the legacy spelling of the body field — a deployed admin
  // console still sends it, so it must keep reassigning.
  const providerId = req.body.providerId || req.body.partnerId;
  try { return ok(res, { assignment: await svc.reassign(req.body.deliveryId, providerId) }, 'Reassigned'); }
  catch (err) { return next(err); }
}

async function getAssignments(req, res, next) {
  try {
    const { status, providerId, deliveryId, zoneId, page = 1, limit = 50 } = req.query;
    // Legacy spelling of the same filter, still sent by deployed clients.
    const requestedProviderId = providerId || req.query.partnerId;
    const filter = {};

    // Operational list: admins see the whole queue, riders see their own
    // work, everyone else is refused (they read assignments via the
    // delivery they own).
    if (!isAdmin(req.user)) {
      if (isOperator(req.user)) {
        const provider = await resolveProviderForUser(req.user);
        // A rider role without a provider profile has no assignments. `null`
        // matches documents whose providerId is unset — the previous
        // '__no_partner__' sentinel could not be cast to an ObjectId, so the
        // query failed with a 400 CastError instead of returning an empty list.
        filter.providerId = provider ? String(provider._id) : null;
      } else {
        return next(forbidden('Assignment lists are for admins and delivery providers'));
      }
    }

    if (status) filter.status = status;
    if (requestedProviderId && !filter.providerId) filter.providerId = requestedProviderId;
    if (deliveryId) filter.deliveryId = deliveryId;
    if (zoneId) filter.zoneId = zoneId;
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const result = await svc.getAssignments(filter, { skip, limit: safeLimit });
    return ok(res, result);
  } catch (err) { return next(err); }
}

/**
 * Providers an admin may pick for this assignment (MVP §8): available, online,
 * under capacity and actually serving the delivery's zone/service/sector.
 * Resolves the constraints from `deliveryId` when given, so the picker shows
 * only riders that will pass the real assignment check.
 */
async function eligibleProviders(req, res, next) {
  try {
    const { deliveryId, zoneId, serviceId, sectorId } = req.query;
    let destZone = zoneId || null;
    let svcId = serviceId || null;
    let destSector = sectorId || null;

    if (deliveryId) {
      const delivery = await deliveriesRepo.findById(deliveryId);
      if (!delivery) return next(notFound('Delivery not found'));
      destZone = destZone || (delivery.destination && delivery.destination.zoneId) || null;
      svcId = svcId || delivery.serviceId || null;
      destSector = destSector || (delivery.destination && delivery.destination.sectorId) || null;
      if (!destZone && delivery.destination && delivery.destination.locationId) {
        try {
          const zs = await zonesService.findZoneForLocation(delivery.destination.locationId);
          destZone = zs.length > 0 ? zs[0]._id : null;
        } catch { destZone = null; }
      }
    }

    const candidates = await providersService.findAvailableForAssignment(svcId, destZone);
    const providers = candidates
      .map((p) => {
        const eligibility = providersService.isProviderEligible(p, { zoneId: destZone, serviceId: svcId });
        if (!eligibility.eligible) return null;
        if (destSector && p.sectorId && String(p.sectorId) !== String(destSector)) return null;
        return {
          _id: p._id,
          name: p.name,
          status: p.status,
          rating: p.rating ?? null,
          activeDeliveries: p.activeDeliveries ?? 0,
          maxActiveAssignments: p.maxActiveAssignments ?? null,
          zoneId: p.zoneId ?? null,
          sectorId: p.sectorId ?? null,
        };
      })
      .filter(Boolean);

    return ok(res, { providers, count: providers.length });
  } catch (err) { return next(err); }
}

module.exports = { createAssignment, automaticAssignment, getAssignment, respondToAssignment, reassign, getAssignments, eligibleProviders };
