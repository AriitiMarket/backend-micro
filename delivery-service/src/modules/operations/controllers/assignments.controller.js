const svc = require('../services/assignments.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const providersRepo = require('../../providers/repositories/providers.repository');
const providersService = require('../../providers/services/providers.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const portsService = require('../services/ports.service');
const { ok, created } = require('../../../shared/utils/response');
const { forbidden, notFound } = require('../../../shared/errors');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const {
  isAdmin, isOperator, resolveProviderForUser, assertCanReadDelivery,
} = require('../../../shared/utils/access');

async function createAssignment(req, res, next) {
  try {
    // Accept either deliveryId or the commerce/admin alias
    const body = { ...req.body };
    if (!body.deliveryId && body.deliveryRequestId) body.deliveryId = body.deliveryRequestId;
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    // The actor is ALWAYS the authenticated caller — a force request without an
    // admin identity is rejected downstream even if the body claims one.
    body.actorId = adminId;
    body.actorName = adminName;
    body.actorRole = req.user ? req.user.role : 'ADMIN';
    const assignment = await svc.createAssignment(body);
    const forced = assignment.forcedAssignment === true;
    sendAudit({
      action: 'DELIVERY_ASSIGNED',
      // A forced assignment is an exception worth flagging in the audit trail.
      level: forced ? 'WARNING' : 'INFO',
      adminId, adminName, targetEntity: 'delivery',
      targetId: body.deliveryId,
      newValue: {
        providerId: assignment.providerId,
        forcedAssignment: forced,
      },
      reason: forced ? assignment.forceReason : null,
      details: forced
        ? {
            originalZoneId: assignment.originalZoneId,
            originalPortId: assignment.originalPortId,
            providerZoneId: assignment.providerZoneId,
            providerPortId: assignment.providerPortId,
          }
        : {},
      ipAddress,
    });
    return created(res, { assignment }, 'Assignment created');
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
  try {
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    // Force fields ride along to the service, which validates them (reason +
    // admin identity) before the outgoing provider is released.
    const assignment = await svc.reassign(
      req.body.deliveryId,
      providerId,
      { id: adminId, name: adminName, role: req.user ? req.user.role : 'ADMIN' },
      { forceAssignment: req.body.forceAssignment, reason: req.body.reason },
    );
    const forced = req.body.forceAssignment === true || req.body.forceAssignment === 'true';
    sendAudit({
      action: 'DELIVERY_REASSIGNED',
      level: forced ? 'WARNING' : 'INFO',
      adminId, adminName, targetEntity: 'delivery',
      targetId: req.body.deliveryId, newValue: { providerId },
      reason: forced ? (req.body.reason || null) : null,
      details: forced ? { forcedAssignment: true } : {},
      ipAddress,
    });
    return ok(res, { assignment }, 'Reassigned');
  } catch (err) { return next(err); }
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
 * under capacity and actually serving the delivery's Zone/Port.
 * Resolves the constraints from `deliveryId` when given, so the picker shows
 * only riders that will pass the real assignment check.
 *
 * `?force=true` returns the FORCE list instead: the same availability /
 * account / capacity rules, but WITHOUT the Zone/Port coverage — for the
 * admin's explicit "Force Assign". Every row carries its zone/port names and an
 * `inCoverage` flag so the UI can label out-of-area providers ("Other Zone" /
 * "Other Port"); the delivery itself is never moved (§12).
 */
async function eligibleProviders(req, res, next) {
  try {
    const { deliveryId, zoneId, serviceId } = req.query;
    const force = req.query.force === 'true' || req.query.force === '1';
    let destZone = zoneId || null;
    let svcId = serviceId || null;
    // The Port is resolved once, here and in the assignment service, so the
    // console's candidate list and the real assignment check agree.
    let destPort = null;

    if (deliveryId) {
      const delivery = await deliveriesRepo.findById(deliveryId);
      if (!delivery) return next(notFound('Delivery not found'));
      destZone = destZone || (delivery.destination && delivery.destination.zoneId) || null;
      // Same port resolution as the assignment service (`destination.portId`,
      // falling back to the legacy top-level `portId`) so the candidate list and
      // the real eligibility check can never disagree.
      destPort = (delivery.destination && delivery.destination.portId) || delivery.portId || null;
      svcId = svcId || delivery.serviceId || null;
      if (!destZone && delivery.destination && delivery.destination.locationId) {
        try {
          const zs = await zonesService.findZoneForLocation(delivery.destination.locationId);
          destZone = zs.length > 0 ? zs[0]._id : null;
        } catch { destZone = null; }
      }
    }

    // Normal: candidates are pre-filtered to the delivery's zone. Force: the
    // candidate pool spans every zone — coverage is exactly what the exception
    // relaxes; availability and capacity are still enforced below.
    const candidates = await providersService.findAvailableForAssignment(
      svcId,
      force ? null : destZone,
    );
    const eligible = providersService.findEligibleProviders(
      { zoneId: destZone, portId: destPort, serviceId: svcId, ignoreCoverage: force },
      candidates,
    );

    // Resolve display names once per distinct zone/port in the result.
    const zoneNameById = new Map();
    const portNameById = new Map();
    await Promise.all([
      ...[...new Set(eligible.map((p) => p.zoneId && String(p.zoneId)).filter(Boolean))]
        .map(async (zid) => {
          if (zoneNameById.has(zid)) return;
          try { zoneNameById.set(zid, (await zonesService.getZone(zid)).name); }
          catch { zoneNameById.set(zid, null); }
        }),
      ...[...new Set(eligible.map((p) => p.portId && String(p.portId)).filter(Boolean))]
        .map(async (pid) => {
          if (portNameById.has(pid)) return;
          try { portNameById.set(pid, (await portsService.getPort(pid)).name); }
          catch { portNameById.set(pid, null); }
        }),
    ]);

    const inCoverage = (p) => {
      const zoneOk = !destZone
        || String(p.zoneId) === String(destZone)
        || (p.zoneIds || []).some((z) => String(z) === String(destZone));
      const portOk = !destPort || !p.portId || String(p.portId) === String(destPort);
      return zoneOk && portOk;
    };

    const providers = eligible
      .map((p) => {
        const zoneIdStr = p.zoneId ? String(p.zoneId) : null;
        const portIdStr = p.portId ? String(p.portId) : null;
        return {
          _id: p._id,
          name: p.name,
          // Availability is provider/system owned — shown read-only here.
          status: p.status,
          isOnline: Boolean(p.availability && p.availability.isOnline),
          rating: p.rating ?? null,
          activeDeliveries: p.activeDeliveries ?? 0,
          maxActiveAssignments: p.maxActiveAssignments ?? null,
          zoneId: zoneIdStr,
          zoneName: zoneIdStr ? zoneNameById.get(zoneIdStr) ?? null : null,
          portId: portIdStr,
          portName: portIdStr ? portNameById.get(portIdStr) ?? null : null,
          inCoverage: inCoverage(p),
        };
      })
      .filter(Boolean);

    return ok(res, {
      providers,
      count: providers.length,
      deliveryZoneId: destZone ? String(destZone) : null,
      deliveryPortId: destPort ? String(destPort) : null,
      force,
    });
  } catch (err) { return next(err); }
}

/**
 * Let the holder of a SINGLE assignment move their delivery forward
 * (pickup → in_transit → delivered). The batch flow already offered this; a
 * rider holding one delivery had no equivalent, so their parcel could not be
 * progressed without an admin doing it by hand.
 */
async function advanceAssignment(req, res, next) {
  try {
    const provider = await providersRepo.findByIdentityUserId(req.user && req.user.id);
    const actor = {
      id: (req.user && req.user.id) || null,
      name: (req.user && (req.user.name || req.user.email)) || null,
      providerId: provider ? provider._id : null,
      isAdmin: isAdmin(req.user),
    };
    const targetStatus = req.body.status || req.body.targetStatus;
    const delivery = await svc.advanceAssignment(req.params.id, targetStatus, actor, {
      note: req.body.note || '',
      proofOfDelivery: req.body.proofOfDelivery || req.body.proof || null,
    });
    return ok(res, { delivery }, 'Delivery updated');
  } catch (err) { return next(err); }
}

module.exports = {
  createAssignment, automaticAssignment, getAssignment, respondToAssignment, reassign,
  getAssignments, eligibleProviders, advanceAssignment,
};
