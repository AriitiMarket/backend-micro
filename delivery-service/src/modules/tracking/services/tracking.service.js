const trackingRepo = require('../repositories/tracking.repository');

async function recordEvent(data) { return trackingRepo.create(data); }
async function getDeliveryHistory(deliveryId) { return trackingRepo.findByDeliveryId(deliveryId); }
async function getLatestLocation(deliveryId) { return trackingRepo.findLatestByDeliveryId(deliveryId); }
async function getProviderHistory(providerId) { return trackingRepo.findByProviderId(providerId); }
async function findNearby(coordinates, maxDistanceMeters) { return trackingRepo.findNearby(coordinates, maxDistanceMeters); }

module.exports = { recordEvent, getDeliveryHistory, getLatestLocation, getProviderHistory, findNearby };
