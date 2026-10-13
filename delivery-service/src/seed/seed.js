const mongoose = require('mongoose');
const Location = require('../modules/locations-expansion/models/Location');
const Zone = require('../modules/locations-expansion/models/Zone');
const DeliveryService = require('../modules/locations-expansion/models/DeliveryService');
const Provider = require('../modules/providers/models/Provider');
const Port = require('../modules/operations/models/Port');
const DeliveryRoute = require('../modules/locations-expansion/models/DeliveryRoute');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/aritii_delivery';

/**
 * GeoJSON Point helper. GeoJSON orders coordinates [longitude, latitude] —
 * the admin map swaps this to Leaflet's [lat, lng] when it draws them, so the
 * seed must store them in the correct GeoJSON order.
 */
const point = (longitude, latitude) => ({
  type: 'Point',
  coordinates: [longitude, latitude],
});

/** Zone coverage geometry, so the map can draw a real radius circle. */
const coverage = (longitude, latitude, radiusKm) => ({
  radiusKm,
  center: point(longitude, latitude),
  includedAreas: [],
  excludedAreas: [],
});

// What this run of the seed did: added versus already present.
const stats = { created: 0, reused: 0 };

/**
 * Create a seed record only if `filter` matches nothing, and return the record.
 *
 * Idempotency is the whole point: a second run must NOT create a duplicate and
 * must NOT delete or overwrite anything an operator has changed since. Every
 * seeded record therefore has a stable natural key (location/zone/service code,
 * provider phone, port location, route endpoints), and an existing document is
 * never written to. The previous implementation started with `deleteMany({})`
 * across six collections, so seeding twice produced the same counts but
 * destroyed every delivery, provider application and location that was not part
 * of the seed.
 */
async function upsert(Model, filter, values) {
  const existing = await Model.findOne(filter);
  if (existing) {
    stats.reused += 1;
    return existing;
  }
  stats.created += 1;
  return Model.create({ ...values, ...filter });
}

async function seed({ uri = MONGODB_URI, connect = true } = {}) {
  if (connect) await mongoose.connect(uri);
  stats.created = 0;
  stats.reused = 0;

  // Real coordinates for each seeded place, stored as GeoJSON [lng, lat].
  const ethiopia = await upsert(Location, { code: 'ET' }, { name: 'Ethiopia', type: 'country', coordinates: point(40.4897, 9.1450) });
  const hararghe = await upsert(Location, { code: 'HR' }, { name: 'Hararghe', type: 'region', parentId: ethiopia._id, coordinates: point(42.0, 9.2) });
  const direDawa = await upsert(Location, { code: 'DD' }, { name: 'Dire Dawa', type: 'region', parentId: ethiopia._id, coordinates: point(41.8661, 9.5931) });
  const addis = await upsert(Location, { code: 'AA' }, { name: 'Addis Ababa', type: 'city', parentId: ethiopia._id, coordinates: point(38.7525, 9.0192) });
  const harar = await upsert(Location, { code: 'HAR' }, { name: 'Harar', type: 'city', parentId: hararghe._id, coordinates: point(42.1256, 9.3125) });
  const ddCity = await upsert(Location, { code: 'DD-C' }, { name: 'Dire Dawa City', type: 'city', parentId: direDawa._id, coordinates: point(41.8661, 9.5931) });

  const hararZone = await upsert(Zone, { code: 'HZ-CITY' }, {
    name: 'Harar City Zone',
    locationIds: [harar._id],
    coverage: coverage(42.1256, 9.3125, 12),
  });
  const oldTownZone = await upsert(Zone, { code: 'HZ-COMM' }, {
    name: 'Harar Old Town Zone',
    locationIds: [harar._id],
    coverage: coverage(42.1250, 9.3200, 6),
  });
  const ddZone = await upsert(Zone, { code: 'DD-ZONE' }, {
    name: 'Dire Dawa Zone',
    locationIds: [ddCity._id],
    coverage: coverage(41.8661, 9.5931, 15),
  });

  const commAPort = await upsert(Port, { name: 'Central Market Port' }, { name: 'Central Market Port', locationId: harar._id, zoneId: oldTownZone._id, coordinates: { latitude: 9.3150, longitude: 42.1150 } });
  const commBPort = await upsert(Port, { name: 'Jugol Gate Port' }, { name: 'Jugol Gate Port', locationId: harar._id, zoneId: hararZone._id, coordinates: { latitude: 9.3250, longitude: 42.1350 } });
  const ddPort = await upsert(Port, { name: 'Bus Station Port' }, { name: 'Bus Station Port', locationId: ddCity._id, zoneId: ddZone._id, coordinates: { latitude: 9.5931, longitude: 41.8661 } });

  const localSvc = await upsert(DeliveryService, { code: 'SVC-LOCAL' }, { name: 'Local Delivery', coverageZones: [hararZone._id], baseFee: 50, perKmFee: 10 });
  const interSvc = await upsert(DeliveryService, { code: 'SVC-INTER' }, { name: 'Intercity Delivery', coverageZones: [hararZone._id, ddZone._id], baseFee: 200, perKmFee: 20, serviceType: 'next_day' });

  const seedProviders = [
    { name: 'Ahmed Ali', phone: '+251911111111', email: 'ahmed@aritii.et', actorType: 'rider', plateNumber: 'ET-MC-001', portId: commAPort._id, serviceId: localSvc._id, zoneId: hararZone._id, zoneIds: [hararZone._id, oldTownZone._id], vehicleType: 'motorcycle', maxCapacityKg: 20 },
    { name: 'Fatima Hassan', phone: '+251922222222', email: 'fatima@aritii.et', actorType: 'rider', plateNumber: 'ET-BC-002', portId: commAPort._id, serviceId: localSvc._id, zoneId: oldTownZone._id, zoneIds: [oldTownZone._id, hararZone._id], vehicleType: 'bicycle', maxCapacityKg: 10 },
    { name: 'Omar Ibrahim', phone: '+251933333333', email: 'omar@aritii.et', actorType: 'driver', plateNumber: 'ET-VN-003', portId: ddPort._id, serviceId: interSvc._id, zoneId: ddZone._id, zoneIds: [ddZone._id], vehicleType: 'van', maxCapacityKg: 100 },
  ];
  for (const provider of seedProviders) {
    await upsert(Provider, { phone: provider.phone }, {
      ...provider, status: 'available', availability: { isOnline: true },
    });
  }

  await upsert(Port, { locationId: harar._id, name: 'Harar Port' }, { capacity: 200, contactPhone: '+251900000001' });
  await upsert(Port, { locationId: ddCity._id, name: 'Dire Dawa Port' }, { capacity: 150, contactPhone: '+251900000002' });

  const routes = [
    { name: 'Harar City Loop', code: 'RT-HAR-LOOP', originLocationId: harar._id, destinationLocationId: harar._id, distanceKm: 15, estimatedDurationMinutes: 45 },
    { name: 'Harar → Dire Dawa', code: 'RT-HAR-DD', originLocationId: harar._id, destinationLocationId: ddCity._id, distanceKm: 55, estimatedDurationMinutes: 180 },
    { name: 'Harar → Dire Dawa (via Port)', code: 'RT-HAR-PORT', originLocationId: harar._id, destinationLocationId: ddCity._id, distanceKm: 55, estimatedDurationMinutes: 190 },
  ];
  for (const route of routes) {
    await upsert(DeliveryRoute, { code: route.code }, route);
  }

  const summary = {
    created: stats.created,
    reused: stats.reused,
    locations: await Location.countDocuments(),
    zones: await Zone.countDocuments(),
    deliveryServices: await DeliveryService.countDocuments(),
    providers: await Provider.countDocuments(),
    ports: await Port.countDocuments(),
    routes: await DeliveryRoute.countDocuments(),
    // `addis` is seeded for the hierarchy example only; touching it keeps the
    // intent explicit for a reader (and proves the tree is complete).
    topLevel: addis._id ? 1 : 0,
    serviceIds: { local: String(localSvc._id), intercity: String(interSvc._id) },
    zoneIds: { harar: String(hararZone._id), community: String(oldTownZone._id), direDawa: String(ddZone._id) },
  };

  if (connect) await mongoose.disconnect();
  return summary;
}

module.exports = { seed, upsert, point, coverage };

// Run only when this file is the entry point: `require`-ing the seed (from a
// test, from another tool, from a migration) must never touch a database.
if (require.main === module) {
  seed()
    .then((summary) => {
      console.log('[seed] Completed (idempotent: nothing was deleted or overwritten):');
      console.log(`  added ${summary.created} record(s), found ${summary.reused} already present`);
      console.log(`  ${summary.locations} locations, ${summary.zones} zones, ${summary.deliveryServices} delivery services`);
      console.log(`  ${summary.providers} providers, ${summary.ports} ports, ${summary.routes} routes`);
    })
    .catch((err) => { console.error('[seed] Error:', err); process.exit(1); });
}

