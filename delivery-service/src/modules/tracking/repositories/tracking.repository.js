const TrackingEvent = require('../models/TrackingEvent');

async function create(data) { return TrackingEvent.create(data); }
async function findByDeliveryId(deliveryId) { return TrackingEvent.find({ deliveryId }).sort({ timestamp: 1 }); }
async function findLatestByDeliveryId(deliveryId) {
  return TrackingEvent.findOne({ deliveryId }).sort({ timestamp: -1 });
}
async function findByProviderId(providerId) {
  return TrackingEvent.find({ providerId }).sort({ timestamp: -1 }).limit(100);
}
async function findNearby(coordinates, maxDistanceMeters = 5000) {
  return TrackingEvent.find({
    location: {
      $nearSphere: { $geometry: { type: 'Point', coordinates }, $maxDistance: maxDistanceMeters },
    },
  }).limit(50);
}

module.exports = { create, findByDeliveryId, findLatestByDeliveryId, findByProviderId, findNearby };
