/**
 * Delivery provider mobile app service
 * Assignment, tracking, delivery confirmation
 */

class ProviderMobileAppService {
  /**
   * Get provider dashboard (lightweight)
   */
  static async getProviderDashboard(providerId) {
    const [assignments, earnings, rating] = await Promise.all([
      Delivery.find({ providerId, status: { $in: ['ASSIGNED', 'IN_TRANSIT'] } })
        .select(['_id', 'orderId', 'pickupLocation', 'deliveryLocation', 'status'])
        .lean(),
      this._getEarnings(providerId),
      this._getRating(providerId)
    ]);

    return {
      activeDeliveries: assignments.length,
      todayEarnings: earnings.today,
      weeklyEarnings: earnings.week,
      rating,
      nextDelivery: assignments[0] || null
    };
  }

  /**
   * Accept/Reject delivery assignment
   */
  static async respondToAssignment(deliveryId, providerId, response) {
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery) throw new Error('Delivery not found');

    if (response === 'accept') {
      delivery.status = 'ACCEPTED';
      delivery.acceptedAt = new Date();
      delivery.providerId = providerId;
    } else if (response === 'reject') {
      delivery.status = 'UNASSIGNED';
      delivery.rejectedAt = new Date();
      delivery.rejectionReason = 'Provider rejected';
    }

    await delivery.save();
    return delivery;
  }

  /**
   * Update GPS location
   */
  static async updateLocation(deliveryId, providerId, location) {
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery || delivery.providerId !== providerId) {
      throw new Error('Unauthorized');
    }

    delivery.location = {
      lat: location.lat,
      lng: location.lng,
      timestamp: new Date(),
      accuracy: location.accuracy
    };

    await delivery.save();

    // Notify buyer
    const realtimeClient = require('../../../shared/utils/realtime-client');
    await realtimeClient.emit('delivery_location_update', {
      deliveryId,
      location
    });

    return delivery;
  }

  /**
   * Confirm pickup
   */
  static async confirmPickup(deliveryId, providerId, photos = []) {
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery || delivery.providerId !== providerId) {
      throw new Error('Unauthorized');
    }

    delivery.status = 'PICKED_UP';
    delivery.pickedUpAt = new Date();
    delivery.pickupPhotos = photos;

    await delivery.save();
    return delivery;
  }

  /**
   * Confirm delivery
   */
  static async confirmDelivery(deliveryId, providerId, signature = null, photos = []) {
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery || delivery.providerId !== providerId) {
      throw new Error('Unauthorized');
    }

    delivery.status = 'DELIVERED';
    delivery.deliveredAt = new Date();
    delivery.signature = signature;
    delivery.deliveryPhotos = photos;

    await delivery.save();
    return delivery;
  }

  /**
   * Report delivery issue
   */
  static async reportIssue(deliveryId, providerId, issue) {
    const exception = await DeliveryException.create({
      deliveryId,
      providerId,
      type: issue.type, // NOT_HOME, WRONG_ADDRESS, DAMAGED, etc
      description: issue.description,
      photos: issue.photos,
      reportedAt: new Date(),
      status: 'OPEN'
    });

    // Notify support
    const realtimeClient = require('../../../shared/utils/realtime-client');
    await realtimeClient.emit('delivery_issue_reported', {
      deliveryId,
      issueId: exception._id,
      type: issue.type
    });

    return exception;
  }

  /**
   * Get nearby deliveries
   */
  static async getNearbyDeliveries(providerId, location, radius = 5) {
    const unassigned = await Delivery.find({
      status: 'UNASSIGNED',
      'pickupLocation.coordinates': {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [location.lng, location.lat]
          },
          $maxDistance: radius * 1000 // Convert to meters
        }
      }
    })
      .select(['_id', 'orderId', 'pickupLocation', 'deliveryLocation', 'estimatedPay'])
      .limit(10)
      .lean();

    return unassigned;
  }

  static async _getEarnings(providerId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [todayStats, weekStats] = await Promise.all([
      Delivery.aggregate([
        { $match: { providerId, deliveredAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$estimatedPay' } } }
      ]),
      Delivery.aggregate([
        { $match: { providerId, deliveredAt: { $gte: weekAgo } } },
        { $group: { _id: null, total: { $sum: '$estimatedPay' } } }
      ])
    ]);

    return {
      today: todayStats[0]?.total || 0,
      week: weekStats[0]?.total || 0
    };
  }

  static async _getRating(providerId) {
    const [rating] = await Delivery.aggregate([
      { $match: { providerId, rating: { $exists: true } } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);

    return rating || { avg: 0, count: 0 };
  }
}

module.exports = ProviderMobileAppService;
