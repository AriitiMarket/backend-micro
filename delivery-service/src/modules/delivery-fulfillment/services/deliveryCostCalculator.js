/**
 * Delivery Cost Calculation Service
 * Calculates shipping costs based on distance, weight, zone, and service type
 */

class DeliveryCostCalculator {
  /**
   * Calculate delivery cost for an order
   */
  async calculateDeliveryCost(order, deliveryDetails) {
    try {
      const {
        pickupLocation,
        deliveryLocation,
        itemWeight,
        itemCount,
        serviceType = 'STANDARD', // STANDARD, EXPRESS, SAME_DAY
        zone
      } = deliveryDetails;

      if (!pickupLocation || !deliveryLocation) {
        throw new Error('Pickup and delivery locations required');
      }

      // 1. Calculate distance
      const distance = this._calculateDistance(pickupLocation, deliveryLocation);

      // 2. Get zone rate card
      const rateCard = await this._getZoneRateCard(zone);

      // 3. Calculate base cost
      const baseCost = this._calculateBaseCost(distance, rateCard);

      // 4. Calculate weight surcharge
      const weightSurcharge = this._calculateWeightSurcharge(itemWeight, rateCard);

      // 5. Calculate service multiplier
      const serviceMultiplier = this._getServiceMultiplier(serviceType);

      // 6. Apply promotional discount (if any)
      const discount = await this._getDeliveryDiscount(order.userId, order.shopId);

      // 7. Calculate final cost
      const subtotal = (baseCost + weightSurcharge) * serviceMultiplier;
      const discountAmount = subtotal * (discount / 100);
      const tax = (subtotal - discountAmount) * 0.05; // 5% tax
      const totalCost = subtotal - discountAmount + tax;

      return {
        baseCost,
        weightSurcharge,
        serviceMultiplier,
        subtotal,
        discountPercent: discount,
        discountAmount,
        tax,
        totalCost,
        currency: 'ETB', // Ethiopian Birr
        breakdown: {
          distance: `${distance.toFixed(2)} km`,
          weight: `${itemWeight.toFixed(2)} kg`,
          itemCount,
          serviceType,
          zone
        }
      };
    } catch (err) {
      console.error('[DeliveryCostCalculator] Error:', err);
      throw err;
    }
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  _calculateDistance(pickup, delivery) {
    const R = 6371; // Earth's radius in km
    const dLat = this._toRad(delivery.lat - pickup.lat);
    const dLon = this._toRad(delivery.lng - pickup.lng);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this._toRad(pickup.lat)) * Math.cos(this._toRad(delivery.lat)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.asin(Math.sqrt(a));
    return R * c;
  }

  _toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * Get zone rate card (from delivery service)
   */
  async _getZoneRateCard(zone) {
    // Default rate card (in Ethiopian Birr)
    // In production, fetch from Delivery Service
    const rateCards = {
      'HARARI': {
        basePricePerKm: 5,
        minPrice: 50,
        maxPrice: 500,
        weightPerKg: 2,
        peakHourMultiplier: 1.2,
        weightThreshold: 20 // kg
      },
      'ADDIS_ABABA': {
        basePricePerKm: 4,
        minPrice: 40,
        maxPrice: 400,
        weightPerKg: 1.5,
        peakHourMultiplier: 1.3,
        weightThreshold: 25
      },
      'OROMIA': {
        basePricePerKm: 6,
        minPrice: 75,
        maxPrice: 600,
        weightPerKg: 2.5,
        peakHourMultiplier: 1.15,
        weightThreshold: 15
      }
    };

    return rateCards[zone] || rateCards['ADDIS_ABABA'];
  }

  /**
   * Calculate base delivery cost
   */
  _calculateBaseCost(distance, rateCard) {
    const cost = distance * rateCard.basePricePerKm;
    return Math.max(cost, rateCard.minPrice);
  }

  /**
   * Calculate weight surcharge
   */
  _calculateWeightSurcharge(weight, rateCard) {
    if (weight <= 0) return 0;
    if (weight <= 5) return 0; // Free for items <= 5kg

    const surchargeWeight = weight - 5;
    return surchargeWeight * rateCard.weightPerKg;
  }

  /**
   * Get service type multiplier
   */
  _getServiceMultiplier(serviceType) {
    const multipliers = {
      'STANDARD': 1.0,      // 1-2 days
      'EXPRESS': 1.5,       // Next day
      'SAME_DAY': 2.0,      // Same day (if available)
      'SCHEDULED': 0.9      // Scheduled future delivery (discount)
    };

    return multipliers[serviceType] || 1.0;
  }

  /**
   * Get promotional discount for delivery
   */
  async _getDeliveryDiscount(userId, shopId) {
    // In production, check promotion service
    // For now, return fixed 0% (no discount)
    return 0;
  }

  /**
   * Get available service types for a route
   */
  async getAvailableServices(pickupLocation, deliveryLocation, zone) {
    const distance = this._calculateDistance(pickupLocation, deliveryLocation);
    const services = ['STANDARD'];

    // Express available for distances <= 50km
    if (distance <= 50) {
      services.push('EXPRESS');
    }

    // Same-day available for distances <= 15km
    if (distance <= 15) {
      services.push('SAME_DAY');
    }

    // Scheduled always available
    services.push('SCHEDULED');

    return services;
  }

  /**
   * Get pricing for all service types
   */
  async getPricingOptions(order, deliveryDetails) {
    const services = await this.getAvailableServices(
      deliveryDetails.pickupLocation,
      deliveryDetails.deliveryLocation,
      deliveryDetails.zone
    );

    const pricingOptions = {};

    for (const service of services) {
      const cost = await this.calculateDeliveryCost(order, {
        ...deliveryDetails,
        serviceType: service
      });
      pricingOptions[service] = cost;
    }

    return pricingOptions;
  }

  /**
   * Validate cost estimate
   */
  validateCost(cost) {
    if (!cost.totalCost || cost.totalCost <= 0) {
      throw new Error('Invalid delivery cost');
    }

    if (cost.totalCost > 5000) {
      // Alert for unusually high costs
      console.warn('[DeliveryCostCalculator] High cost:', cost);
    }

    return true;
  }
}

module.exports = new DeliveryCostCalculator();
