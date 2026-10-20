const mongoose = require('mongoose');
const requestsRepo = require('../repositories/delivery-request.repository');
const deliveriesRepo = require('../repositories/delivery.repository');
const locationsService = require('../../locations-expansion/services/locations.service');
const zonesService = require('../../locations-expansion/services/zones.service');
const validators = require('../validators');

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
  // The Commerce handoff is an API contract: validate it before ANY document is
  // written. `validateRequestHandoffInput` existed in the module but was never
  // called, so an incomplete handoff (no pickup, no destination, negative
  // quantities, impossible coordinates) used to create a delivery that could
  // never be picked up and whose capacity/weight numbers were meaningless.
  validators.validateRequestHandoffInput(data);
  const paymentMethod = validators.normalizePaymentMethod(data.paymentMethod) || 'COD';
  const deliveryFee = Math.round((Number(data.deliveryFee) || 0) * 100) / 100;
  const delivererShareRate = Number(data.delivererShareRate ?? 80);
  if (deliveryFee < 0 || !Number.isFinite(deliveryFee) || !Number.isFinite(delivererShareRate) || delivererShareRate < 0 || delivererShareRate > 100) {
    throw Object.assign(new Error('Delivery fee or deliverer share snapshot is invalid'), { status: 422, code: 'INVALID_DELIVERY_FEE' });
  }
  const delivererEarning = Math.round(deliveryFee * delivererShareRate) / 100;

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

  // Auto-resolve zone if not provided (one centralized resolver)
  const deliveryAddress = { ...data.deliveryAddress };
  if (!deliveryAddress.zoneId) {
    const zone = await zonesService.resolveDeliveryArea({ locationId: data.destinationLocationId });
    if (zone) deliveryAddress.zoneId = zone._id;
  }

  // One centralized requestability gate: unknown zone, paused zone, outside
  // service hours or not-yet-live zone rejects the request with a clear code
  // BEFORE any Delivery row is created. Existing deliveries are untouched.
  let resolvedPortId = null;
  if (deliveryAddress.zoneId) {
    let zone = null;
    try { zone = await zonesService.getZone(deliveryAddress.zoneId); } catch { zone = null; }
    if (!zone) throw Object.assign(new Error('Zone not serviceable: ZONE_NOT_FOUND'), { status: 400, code: 'ZONE_NOT_FOUND' });
    await zonesService.assertZoneRequestable(zone);
    // Zone says WHERE; the Port is the known local point that will serve it.
    // Resolved once, here, so assignment and tracking never re-derive it.
    const port = await zonesService.resolveZonePort(zone._id);
    resolvedPortId = port ? port._id : null;
  }

  // Location references that do not resolve to a real location are dropped from
  // the RECORD as well as stored as null, so no document ends up pointing at an
  // orphan location id (the text address snapshot below still carries everything
  // the coordinator needs).
  const pickupLocationId = keepIfKnown(data.pickupLocationId, pickup);
  const destinationLocationId = keepIfKnown(data.destinationLocationId, destination);

  // Ensure location hierarchy snapshots are preserved
  // (regionId/regionName/areaId/areaName/sectorId/sectorName come from Commerce)
  const savedData = {
    ...data,
    paymentMethod,
    pickupLocationId,
    destinationLocationId,
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
      // The parcel snapshot comes from the request's own items, so the buyer,
      // the rider and the admin all see the same count and declared value.
      const requestItems = Array.isArray(request.items) ? request.items : [];
      const itemCount = requestItems.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);
      const totalValue = Number(request.totalValue) || 0;
      const deliveryData = {
        idempotencyKey: `order:${data.orderId}`,
        orderId: data.orderId,
        sellerId: data.sellerId,
        buyerId: data.buyerId,
        paymentMethod,
        paymentAmount: Number(data.paymentAmount) || 0,
        itemCount,
        totalValue,
        deliveryFee,
        deliveryFeeRuleId: data.deliveryFeeRuleId || null,
        delivererShareRate,
        delivererEarning,
        platformDeliveryShare: Math.round((deliveryFee - delivererEarning) * 100) / 100,
        proofRules: { requireCodConfirmation: paymentMethod === 'COD' },
        status: 'pending',
        origin: {
          regionId: pickupAddr.regionId || null,
          areaId: pickupAddr.areaId || null,
          cityId: pickupAddr.cityId || null,
          sectorId: pickupAddr.sectorId || null,
          locationId: pickupLocationId || null,
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
          // Sector fields are legacy: new requests set them to null and no
          // delivery logic branches on them any more.
          sectorId: deliveryAddress.sectorId || null,
          locationId: destinationLocationId || deliveryAddress.locationId || null,
          zoneId: deliveryAddress.zoneId || null,
          portId: resolvedPortId,
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
