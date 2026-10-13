'use strict';
/**
 * Fixtures for the integration suites — the MVP shape the seed produces
 * (Country → Region → City, with Zone and Port as their own models), plus the
 * catalogue entry and route a delivery needs.
 */

async function seedGeography(models, options = {}) {
  const { active = true } = options;
  const country = await models.Location.create({ name: 'Ethiopia', type: 'country', code: `ET-${Math.random().toString(36).slice(2, 7)}` });
  const region = await models.Location.create({ name: 'Hararghe', type: 'region', parentId: country._id });
  const city = await models.Location.create({ name: 'Harar', type: 'city', parentId: region._id });
  const otherCity = await models.Location.create({ name: 'Dire Dawa', type: 'city', parentId: region._id });
  const inactiveCity = await models.Location.create({ name: 'Closed Town', type: 'city', parentId: region._id, isActive: false });

  const zone = await models.Zone.create({
    name: 'Harar City Zone',
    code: `HZ-${Math.random().toString(36).slice(2, 7)}`,
    locationIds: [city._id],
  });
  const service = await models.DeliveryService.create({
    name: 'Local Delivery', code: `SVC-${Math.random().toString(36).slice(2, 7)}`, coverageZones: [zone._id],
  });
  const port = await models.Port.create({ name: 'Central Market Port', locationId: city._id, zoneId: zone._id });
  const otherPort = await models.Port.create({ name: 'Bus Station Port', locationId: city._id, zoneId: zone._id });
  const route = await models.DeliveryRoute.create({
    name: 'Harar City Loop', code: `R-${Math.random().toString(36).slice(2, 7)}`,
    originLocationId: city._id, destinationLocationId: city._id,
  });

  return {
    country, region, city, otherCity, inactiveCity, zone, service, port, otherPort, route,
    // Address snapshot the way Commerce sends it.
    pickupAddress: {
      regionId: region._id, regionName: region.name,
      cityId: city._id, cityName: city.name,
      shopId: 'shop-1', shopName: 'Aritii Coffee Shop',
      addressDetail: 'Shop Street 1', contactName: 'Seller', contactPhone: '+251911000000',
    },
    deliveryAddress: {
      regionId: region._id, regionName: region.name,
      cityId: city._id, cityName: city.name,
      addressDetail: 'Home Street 9', contactName: 'Buyer', contactPhone: '+251922000000',
    },
  };
}

/** A rider/business record owned by an identity account. */
async function createProvider(models, overrides = {}) {
  return models.Provider.create({
    name: 'Provider One',
    phone: '+251900000111',
    status: 'available',
    availability: { isOnline: true, lastSeenAt: new Date() },
    maxActiveAssignments: 3,
    maxCapacityKg: 50,
    vehicleType: 'motorcycle',
    ...overrides,
  });
}

/** The payload Commerce posts to `POST /internal/delivery/request`. */
function handoffPayload(geo, orderId, overrides = {}) {
  return {
    orderId,
    sellerId: 'seller-1',
    buyerId: 'buyer-1',
    pickupAddress: geo.pickupAddress,
    deliveryAddress: geo.deliveryAddress,
    destinationLocationId: String(geo.city._id),
    pickupLocationId: String(geo.city._id),
    items: [{ name: 'Coffee', quantity: 1, weight: 1, value: 500 }],
    totalValue: 500,
    totalWeight: 1,
    paymentMethod: 'PREPAID',
    paymentAmount: 0,
    ...overrides,
  };
}

async function handoff(harness, payload) {
  return harness.request('/internal/delivery/request', { method: 'POST', internal: 'commerce', body: payload });
}

/** Hand off an order and return the materialized delivery document. */
async function createDelivery(harness, geo, orderId, overrides = {}) {
  const res = await handoff(harness, handoffPayload(geo, orderId, overrides));
  if (res.status !== 201) {
    throw new Error(`handoff failed with ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const delivery = await harness.models.Delivery.findOne({ orderId });
  if (!delivery) throw new Error(`no delivery materialized for ${orderId}`);
  return delivery;
}

module.exports = { seedGeography, createProvider, handoffPayload, handoff, createDelivery };
