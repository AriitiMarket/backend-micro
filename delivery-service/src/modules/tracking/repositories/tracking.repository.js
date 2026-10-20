const TrackingEvent = require('../models/TrackingEvent');

async function create(data) { return TrackingEvent.create(data); }
async function findByDeliveryId(deliveryId) { return TrackingEvent.find({ deliveryId }).sort({ timestamp: 1 }); }
async function findLatestByDeliveryId(deliveryId) {
  return TrackingEvent.findOne({ deliveryId }).sort({ timestamp: -1 });
}

/**
 * The latest event for EACH of many deliveries, in ONE query.
 *
 * A tracking list needs the current position of every row it shows. Asking
 * for them one at a time turns a 25-row page into 25 round trips; this
 * aggregation groups the events by delivery and keeps the newest one per
 * group, so the whole list costs a single request.
 */
async function findLatestByDeliveryIds(deliveryIds = []) {
  const ids = [...new Set((deliveryIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  return TrackingEvent.aggregate([
    { $match: { deliveryId: { $in: ids } } },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$deliveryId',
        latest: { $first: '$$ROOT' },
      },
    },
  ]);
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

module.exports = { create, findByDeliveryId, findLatestByDeliveryId, findLatestByDeliveryIds, findByProviderId, findNearby };
