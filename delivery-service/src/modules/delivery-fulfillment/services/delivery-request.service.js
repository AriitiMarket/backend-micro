const mongoose = require('mongoose');
const requestsRepo = require('../repositories/delivery-request.repository');
const deliveriesRepo = require('../repositories/delivery.repository');
const locationsService = require('../../locations-expansion/services/locations.service');
const zonesService = require('../../locations-expansion/services/zones.service');

// An order handoff must never be rejected because a location id is unusable:
// buyers save addresses against an older location tree, shops may have no pin
// at all, and Commerce may send a raw string. Unknown/uncastable ids are
// treated as "no location" instead of failing the order — the text address
// snapshot below still carries everything the coordinator needs.
async function findLocationIfKnown(id) {
  if (!id || !mongoose.isValidObjectId(id)) return null;
  try { return await locationsService.getLocation(id); } catch { return null; }
}

function keepIfKnown(id, location) {
  return location ? id : null;
}

async function createRequest(data) {
  // Idempotency (MVP §10): one order hands over to Delivery exactly once.
  // Commerce retries must not create a second request or a second Delivery.
  let request = null;
  if (data.orderId) {
    request = await requestsRepo.findByOrderId(data.orderId);
  }

  // Validate pickup location exists and is active (only when we know it)
  const pickup = await findLocationIfKnown(data.pickupLocationId);
  if (pickup && !pickup.isActive) throw Object.assign(new Error('Pickup location is inactive'), { status: 400 });

  // Validate destination location exists and is active (only when we know it)
  const destination = await findLocationIfKnown(data.destinationLocationId);
  if (destination && !destination.isActive) throw Object.assign(new Error('Destination location is inactive'), { status: 400 });

  // Auto-resolve zone if not provided
  const deliveryAddress = { ...data.deliveryAddress };
  if (destination) {
    const destZones = await zonesService.findZoneForLocation(data.destinationLocationId);
    if (destZones.length > 0 && !deliveryAddress.zoneId) {
      deliveryAddress.zoneId = destZones[0]._id;
    }
  }

  // Ensure location hierarchy snapshots are preserved
  // (regionId/regionName/areaId/areaName/sectorId/sectorName come from Commerce)
  const savedData = {
    ...data,
    pickupLocationId: keepIfKnown(data.pickupLocationId, pickup),
    destinationLocationId: keepIfKnown(data.destinationLocationId, destination),
    deliveryAddress,
    pickupAddress: { ...data.pickupAddress },
    requestedAt: new Date(),
  };

  if (!request) request = await requestsRepo.create(savedData);

  // Auto-materialize a pending Delivery so Admin can assign it immediately.
  if (data.orderId) {
    const existing = await deliveriesRepo.findByOrderId(data.orderId);
    if (!existing) {
      const pickupAddr = data.pickupAddress || {};
      const deliveryData = {
        idempotencyKey: `order:${data.orderId}`,
        orderId: data.orderId,
        sellerId: data.sellerId,
        buyerId: data.buyerId,
        paymentMethod: data.paymentMethod || 'COD',
        paymentAmount: Number(data.paymentAmount) || 0,
        proofRules: { requireCodConfirmation: (data.paymentMethod || 'COD') === 'COD' },
        status: 'pending',
        origin: {
          regionId: pickupAddr.regionId || null,
          areaId: pickupAddr.areaId || null,
          cityId: pickupAddr.cityId || null,
          sectorId: pickupAddr.sectorId || null,
          locationId: data.pickupLocationId || null,
          regionName: pickupAddr.regionName || '',
          areaName: pickupAddr.areaName || '',
          cityName: pickupAddr.cityName || '',
          sectorName: pickupAddr.sectorName || '',
          shopId: pickupAddr.shopId || '',
          shopName: pickupAddr.shopName || '',
          businessId: pickupAddr.businessId || null,
          addressDetail: pickupAddr.addressDetail || '',
          landmark: pickupAddr.landmark || '',
          building: pickupAddr.building || '',
          contactName: pickupAddr.contactName || '',
          contactPhone: pickupAddr.contactPhone || '',
          coordinates: pickupAddr.coordinates || { latitude: null, longitude: null },
        },
        destination: {
          regionId: deliveryAddress.regionId || null,
          areaId: deliveryAddress.areaId || null,
          cityId: deliveryAddress.cityId || null,
          sectorId: deliveryAddress.sectorId || data.destinationLocationId || null,
          locationId: data.destinationLocationId || deliveryAddress.locationId || null,
          zoneId: deliveryAddress.zoneId || null,
          regionName: deliveryAddress.regionName || '',
          areaName: deliveryAddress.areaName || '',
          cityName: deliveryAddress.cityName || '',
          sectorName: deliveryAddress.sectorName || '',
          addressDetail: deliveryAddress.addressDetail || '',
          landmark: deliveryAddress.landmark || '',
          building: deliveryAddress.building || '',
          contactName: deliveryAddress.contactName || '',
          contactPhone: deliveryAddress.contactPhone || '',
          additionalInstructions: deliveryAddress.additionalInstructions || data.specialInstructions || '',
          coordinates: deliveryAddress.coordinates || { latitude: null, longitude: null },
        },
        metadata: { deliveryRequestId: request._id, specialInstructions: data.specialInstructions || '' },
      };
      let newDelivery;
      try {
        newDelivery = await deliveriesRepo.create(deliveryData);
      } catch (err) {
        if (err.code !== 11000) throw err;
        newDelivery = await deliveriesRepo.findByOrderId(data.orderId);
        if (!newDelivery) throw err;
      }
      
      const auditClient = require('../../../shared/utils/audit-client');
      if (auditClient && typeof auditClient.sendAudit === 'function') {
        auditClient.sendAudit({
          action: 'DELIVERY_CREATED',
          targetEntity: 'delivery',
          targetId: newDelivery._id
        }).catch(() => null);
      }
    }
  }

  return request;
}

async function getRequest(id) {
  const req = await requestsRepo.findById(id);
  if (!req) throw Object.assign(new Error('Delivery request not found'), { status: 404 });
  return req;
}

async function getRequestByOrderId(orderId) { return requestsRepo.findByOrderId(orderId); }
async function getRequests(filter = {}, options = {}) { return requestsRepo.findAll(filter, options); }
async function countRequests(filter = {}) { return requestsRepo.count(filter); }

async function validateAddress(data) {
  const { locationId, zoneId } = data;
  let location = null;
  if (locationId) location = await locationsService.getLocation(locationId);
  let zone = null;
  if (zoneId) {
    zone = await zonesService.getZone(zoneId);
  } else if (locationId) {
    const zones = await zonesService.findZoneForLocation(locationId);
    if (zones.length > 0) zone = zones[0];
  }
  const coverage = await zonesService.checkCoverage(locationId);
  return {
    valid: coverage.covered,
    location: location ? { id: location._id, name: location.name, type: location.type } : null,
    zone: zone ? { id: zone._id, name: zone.name, code: zone.code } : null,
    coverage,
  };
}

module.exports = { createRequest, getRequest, getRequestByOrderId, getRequests, countRequests, validateAddress };
