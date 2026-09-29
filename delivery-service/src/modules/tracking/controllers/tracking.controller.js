const svc = require('../services/tracking.service');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const { ok } = require('../../../shared/utils/response');
const { assertCanReadDelivery } = require('../../../shared/utils/access');

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

async function recordEvent(req, res, next) {
  try { return ok(res, { event: await svc.recordEvent(req.body) }, 'Tracking event recorded'); }
  catch (err) { return next(err); }
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
    const coords = [parseFloat(longitude), parseFloat(latitude)];
    const events = await svc.findNearby(coords, parseInt(maxDistance) || 5000);
    return ok(res, { events, count: events.length });
  } catch (err) { return next(err); }
}

module.exports = { recordEvent, getDeliveryHistory, getLatestLocation, findNearby };
