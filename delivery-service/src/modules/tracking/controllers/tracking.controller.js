const svc = require('../services/tracking.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const { ok } = require('../../../shared/utils/response');
const { validationError, notFound, forbidden, conflict } = require('../../../shared/errors');
const { assertCanReadDelivery, isAdmin, isOperator, resolveProviderForUser } = require('../../../shared/utils/access');
const { tryNormalizeDeliveryStatus, TERMINAL_DELIVERY_STATUSES } = require('../../../shared/constants');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

/**
 * Tracking reads are delivery-scoped: verify the caller may see the delivery
 * first (MVP §27). An unknown id still returns an empty event list — there is
 * no data to leak and the admin UI keeps its "no events yet" empty state.
 */
async function canReadDeliveryOrMissing(deliveryId, user) {
  let delivery = null;
  try { delivery = await deliveriesRepo.findById(deliveryId); } catch { delivery = null; }
  if (delivery) await assertCanReadDelivery(delivery, user);
}

// A delivery whose journey is over (or was aborted) accepts no further tracking:
// the timeline must not keep growing after the delivery was closed. Derived from
// the canonical terminal set — `failed` is excluded on purpose, because a failed
// delivery can still be retried and would then legitimately move again.
const CLOSED_TRACKING_STATUSES = TERMINAL_DELIVERY_STATUSES;

/** Coordinates must be a real GeoJSON Point: [longitude, latitude]. */
function validateCoordinates(location) {
  if (location === undefined || location === null) return null;
  const coordinates = location.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2
    || !coordinates.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw validationError(['"location.coordinates" must be [longitude, latitude]']);
  }
  const [longitude, latitude] = coordinates;
  if (longitude < -180 || longitude > 180) throw validationError(['"location.coordinates[0]" (longitude) must be between -180 and 180']);
  if (latitude < -90 || latitude > 90) throw validationError(['"location.coordinates[1]" (latitude) must be between -90 and 90']);
  if (location.type !== undefined && location.type !== 'Point') throw validationError(['"location.type" must be "Point"']);
  return { type: 'Point', coordinates: [longitude, latitude] };
}

/**
 * Record one tracking event.
 *
 * Authorization (backend-enforced, never the frontend):
 *   * ADMIN     — may record an event for any delivery (operational override);
 *   * PROVIDER  — may only record events for a delivery currently assigned to
 *                 their own Provider document.
 * The provider identity is always derived from the authenticated context: a
 * `providerId` in the body is ignored, so an event can never be attributed to
 * another provider.
 */
async function recordEvent(req, res, next) {
  try {
    const body = req.body || {};
    const deliveryId = body.deliveryId || body.delivery_id;
    if (!deliveryId || !isValidObjectId(deliveryId)) {
      throw validationError(['"deliveryId" must be a valid delivery identifier']);
    }
    const delivery = await deliveriesRepo.findById(deliveryId);
    if (!delivery) throw notFound('Delivery not found');

    if (!isAdmin(req.user)) {
      if (!isOperator(req.user)) {
        throw forbidden('Tracking updates are for the assigned delivery provider');
      }
      const provider = await resolveProviderForUser(req.user);
      if (!provider || String(delivery.providerId || '') !== String(provider._id)) {
        throw forbidden('You can only update tracking for your own assigned deliveries');
      }
    }

    if (CLOSED_TRACKING_STATUSES.includes(delivery.status)) {
      throw conflict(`Tracking is closed for a ${delivery.status} delivery`, 'TRACKING_CLOSED');
    }

    // `status` is optional: a pure location ping records the delivery's current
    // status. When supplied it must be a known lifecycle status (the enum used to
    // accept only the original eight, so newer stages were rejected by the model).
    let status = delivery.status;
    if (body.status !== undefined && body.status !== null && String(body.status).trim() !== '') {
      status = tryNormalizeDeliveryStatus(body.status);
      if (!status) throw validationError([`Unknown delivery status "${body.status}"`]);
    }

    const timestamp = body.timestamp === undefined || body.timestamp === null ? new Date() : new Date(body.timestamp);
    if (Number.isNaN(timestamp.getTime())) throw validationError(['"timestamp" must be a valid date']);

    const event = await svc.recordEvent({
      deliveryId: delivery._id,
      providerId: delivery.providerId || null,
      status,
      location: validateCoordinates(body.location) || undefined,
      accuracy: typeof body.accuracy === 'number' ? body.accuracy : null,
      speed: typeof body.speed === 'number' ? body.speed : null,
      heading: typeof body.heading === 'number' ? body.heading : null,
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
      timestamp,
    });
    return ok(res, { event }, 'Tracking event recorded');
  } catch (err) { return next(err); }
}

async function getDeliveryHistory(req, res, next) {
  try {
    await canReadDeliveryOrMissing(req.params.deliveryId, req.user);
    const e = await svc.getDeliveryHistory(req.params.deliveryId);
    return ok(res, { events: e, count: e.length });
  }
  catch (err) { return next(err); }
}

async function getLatestLocation(req, res, next) {
  try {
    await canReadDeliveryOrMissing(req.params.deliveryId, req.user);
    return ok(res, { location: await svc.getLatestLocation(req.params.deliveryId) });
  } catch (err) { return next(err); }
}

async function findNearby(req, res, next) {
  try {
    const { longitude, latitude, maxDistance } = req.query;
    const lng = Number.parseFloat(longitude);
    const lat = Number.parseFloat(latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw validationError(['"longitude" and "latitude" are required and must be numbers']);
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw validationError(['"longitude"/"latitude" are out of range']);
    }
    const distance = Number.parseInt(maxDistance, 10);
    const events = await svc.findNearby([lng, lat], Number.isFinite(distance) && distance > 0 ? distance : 5000);
    return ok(res, { events, count: events.length });
  } catch (err) { return next(err); }
}

module.exports = { recordEvent, getDeliveryHistory, getLatestLocation, findNearby };
