const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const shipmentsRepo = require('../repositories/shipments.repository');
const routesRepo = require('../../locations-expansion/repositories/routes.repository');
const locationsService = require('../../locations-expansion/services/locations.service');
const deliveryServicesService = require('../../locations-expansion/services/deliveryServices.service');

const MAX_CANDIDATE_DELIVERIES = 500;

function str(v) { return v == null ? null : String(v); }

async function nameOfLocation(id) {
  if (!id) return 'Anywhere';
  try {
    const loc = await locationsService.getLocation(id);
    return loc ? loc.name : String(id).slice(0, 8);
  } catch { return String(id).slice(0, 8); }
}

async function nameOfService(id) {
  if (!id) return 'Any service';
  try {
    const svc = await deliveryServicesService.getService(id);
    return svc ? svc.name : 'Unknown service';
  } catch { return 'Unknown service'; }
}

/**
 * Compatible delivery groups for Admin-reviewed consolidation (MVP §18).
 *
 * A group is: same origin + same destination + same service, still `pending`
 * and not already inside a shipment. Everything shown as the compatibility
 * reason comes from the data, never from frontend assumptions.
 */
async function getCandidates(filter = {}) {
  const query = { status: 'pending', shipmentId: null };
  if (filter.originLocationId) query['origin.locationId'] = filter.originLocationId;
  if (filter.destinationLocationId) query['destination.locationId'] = filter.destinationLocationId;
  if (filter.serviceId) query.serviceId = filter.serviceId;

  const deliveries = await deliveriesRepo.findAll(query, { limit: MAX_CANDIDATE_DELIVERIES });

  const groups = {};
  for (const d of deliveries) {
    const key = `${str(d.origin?.locationId)}_${str(d.destination?.locationId)}_${str(d.serviceId)}`;
    if (!groups[key]) {
      groups[key] = {
        id: key,
        originLocationId: d.origin?.locationId ?? null,
        destinationLocationId: d.destination?.locationId ?? null,
        serviceId: d.serviceId ?? null,
        deliveryIds: [],
        orderIds: [],
        totalWeight: 0,
        deliveryCount: 0,
      };
    }
    groups[key].deliveryIds.push(String(d._id));
    groups[key].orderIds.push(String(d.orderId));
    groups[key].totalWeight += d.metadata?.weight || d.totalWeight || 0;
    groups[key].deliveryCount += 1;
  }

  const result = await Promise.all(
    Object.values(groups).map(async (g) => {
      const [originName, destinationName, serviceName] = await Promise.all([
        nameOfLocation(g.originLocationId),
        nameOfLocation(g.destinationLocationId),
        nameOfService(g.serviceId),
      ]);
      return {
        ...g,
        originName,
        destinationName,
        serviceName,
        groupName: `${serviceName} · ${g.deliveryCount} deliver${g.deliveryCount === 1 ? 'y' : 'ies'}`,
        reason: `Same origin (${originName}), destination (${destinationName}) and service (${serviceName})`,
      };
    })
  );

  // Biggest, heaviest groups first — those are the useful ones to review.
  return result.sort((a, b) => b.deliveryCount - a.deliveryCount || b.totalWeight - a.totalWeight);
}

/** Shipment reference shown in the UI and used for lookups (MVP §17). */
function newShipmentNumber() {
  return `SHP-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

/**
 * Confirm a reviewed group into a Shipment.
 *
 * Concurrency (MVP §29): the shipment is created first, then the deliveries
 * are claimed with a conditional update (`shipmentId: null AND status:
 * 'pending'`). If another admin claimed any of them first, the claim count
 * will not match, the shipment is rolled back and a 409 is returned.
 */
async function confirmConsolidation(data, actor) {
  const { deliveryIds, originLocationId, destinationLocationId, originHubId, destinationHubId, routeId, serviceId, providerId, maxWeight } = data;
  if (!deliveryIds || deliveryIds.length === 0) throw Object.assign(new Error('No deliveries selected for consolidation'), { status: 400 });

  if (routeId) {
    const route = await routesRepo.findById(routeId);
    if (!route || route.status !== 'active') throw Object.assign(new Error('Invalid or inactive route'), { status: 400 });
  }

  const items = [];
  let usedWeight = 0;
  let usedItems = 0;

  for (const did of deliveryIds) {
    const delivery = await deliveriesRepo.findById(did);
    if (!delivery) throw Object.assign(new Error(`Delivery ${did} not found`), { status: 404 });
    if (delivery.shipmentId) throw Object.assign(new Error(`Delivery ${did} already belongs to a shipment`), { status: 409 });
    if (delivery.status !== 'pending') throw Object.assign(new Error(`Delivery ${did} is not in a valid state for consolidation`), { status: 400 });

    if (originLocationId && str(delivery.origin.locationId) !== str(originLocationId)) {
      throw Object.assign(new Error(`Delivery ${did} origin does not match shipment origin`), { status: 400 });
    }
    if (destinationLocationId && str(delivery.destination.locationId) !== str(destinationLocationId)) {
      throw Object.assign(new Error(`Delivery ${did} destination does not match shipment destination`), { status: 400 });
    }

    const weight = delivery.metadata?.weight || 0;
    items.push({
      deliveryId: delivery._id,
      orderId: delivery.orderId,
      sellerId: delivery.sellerId,
      buyerId: delivery.buyerId,
      weight,
      quantity: 1,
      status: 'added',
    });
    usedWeight += weight;
    usedItems++;
  }

  if (maxWeight && usedWeight > maxWeight) {
    throw Object.assign(new Error(`Shipment capacity exceeded: max ${maxWeight}, required ${usedWeight}`), { status: 400 });
  }

  const [originName, destinationName] = await Promise.all([
    nameOfLocation(originLocationId),
    nameOfLocation(destinationLocationId),
  ]);

  const shipment = await shipmentsRepo.create({
    shipmentNumber: newShipmentNumber(),
    status: 'planning',
    originLocationId,
    destinationLocationId,
    originHubId,
    destinationHubId,
    routeId,
    serviceId,
    providerId,
    // Names live under `snapshots` — top-level copies are not schema paths.
    snapshots: { originName, destinationName },
    capacity: { maxWeight: maxWeight || null, usedWeight, maxItems: null, usedItems },
    items,
    history: [{
      status: 'planning',
      timestamp: new Date(),
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.name : null,
      note: 'Shipment created via consolidation',
    }],
  });

  // Atomic claim — the loser of a two-admin race rolls back cleanly.
  const claim = await deliveriesRepo.updateMany(
    { _id: { $in: deliveryIds }, shipmentId: null, status: 'pending' },
    { $set: { shipmentId: String(shipment._id) } }
  );
  if (claim.modifiedCount !== deliveryIds.length) {
    await shipmentsRepo.removeById(shipment._id);
    throw Object.assign(
      new Error('One or more deliveries were consolidated by another admin. Refresh and try again.'),
      { status: 409 }
    );
  }

  return shipment;
}

module.exports = {
  getCandidates,
  confirmConsolidation,
};
