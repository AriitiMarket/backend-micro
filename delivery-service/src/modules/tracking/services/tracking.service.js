const trackingRepo = require('../repositories/tracking.repository');

async function recordEvent(data) { return trackingRepo.create(data); }
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
  recordEvent, getDeliveryHistory, getLatestLocation, getLatestLocations,
  getProviderHistory, findNearby,
};
