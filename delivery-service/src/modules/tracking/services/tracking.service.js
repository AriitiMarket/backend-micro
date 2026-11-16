'use strict';

const trackingRepo = require('../repositories/tracking.repository');
const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const { isAdmin, isOperator, resolveProviderForUser } = require('../../../shared/utils/access');

/**
 * Verifies that the authenticated user attempting to submit tracking data
 * is either an Admin or the active assigned provider for the delivery.
 */
async function verifyTrackingOwnership(deliveryId, user) {
  if (!user || isAdmin(user)) return true;
  if (!isOperator(user)) {
    throw Object.assign(new Error('Tracking updates are for the assigned delivery provider'), { status: 403 });
  }
  const delivery = await deliveriesRepo.findById(deliveryId);
  if (!delivery) {
    throw Object.assign(new Error('Delivery not found'), { status: 404 });
  }
  const provider = await resolveProviderForUser(user);
  if (!provider || String(delivery.providerId || '') !== String(provider._id)) {
    throw Object.assign(new Error('You can only update tracking for your own assigned deliveries'), { status: 403 });
  }
  return true;
}

async function recordEvent(data, user = null) {
  if (user && data.deliveryId) {
    await verifyTrackingOwnership(data.deliveryId, user);
  }
  return trackingRepo.create(data);
}

async function getDeliveryHistory(deliveryId) { return trackingRepo.findByDeliveryId(deliveryId); }
async function getLatestLocation(deliveryId) { return trackingRepo.findLatestByDeliveryId(deliveryId); }

/**
 * The latest known position of MANY deliveries, keyed by delivery id.
 * One query for the whole list instead of one per row.
 */
async function getLatestLocations(deliveryIds = []) {
  const rows = await trackingRepo.findLatestByDeliveryIds(deliveryIds);
  const locations = {};
  for (const row of rows || []) {
    const id = String(row._id);
    locations[id] = row.latest || null;
  }
  return locations;
}

async function getProviderHistory(providerId) { return trackingRepo.findByProviderId(providerId); }
async function findNearby(coordinates, maxDistanceMeters) { return trackingRepo.findNearby(coordinates, maxDistanceMeters); }

module.exports = {
  recordEvent,
  verifyTrackingOwnership,
  getDeliveryHistory,
  getLatestLocation,
  getLatestLocations,
  getProviderHistory,
  findNearby,
};
