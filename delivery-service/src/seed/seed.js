const mongoose = require('mongoose');
const Location = require('../modules/locations-expansion/models/Location');
const Zone = require('../modules/locations-expansion/models/Zone');
const DeliveryService = require('../modules/locations-expansion/models/DeliveryService');
const Provider = require('../modules/providers/models/Provider');
const Hub = require('../modules/operations/models/Hub');
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

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('[seed] Connected to MongoDB');

  await Promise.all([
    Location.deleteMany({}), Zone.deleteMany({}), DeliveryService.deleteMany({}),
    Provider.deleteMany({}), Hub.deleteMany({}), DeliveryRoute.deleteMany({}),
  ]);

  // Real coordinates for each seeded place, stored as GeoJSON [lng, lat].
  const ethiopia = await Location.create({ name: 'Ethiopia', type: 'country', code: 'ET', coordinates: point(40.4897, 9.1450) });
  const hararghe = await Location.create({ name: 'Hararghe', type: 'region', parentId: ethiopia._id, code: 'HR', coordinates: point(42.0, 9.2) });
  const direDawa = await Location.create({ name: 'Dire Dawa', type: 'region', parentId: ethiopia._id, code: 'DD', coordinates: point(41.8661, 9.5931) });
  const addis = await Location.create({ name: 'Addis Ababa', type: 'city', parentId: ethiopia._id, code: 'AA', coordinates: point(38.7525, 9.0192) });
  const harar = await Location.create({ name: 'Harar', type: 'city', parentId: hararghe._id, code: 'HAR', coordinates: point(42.1256, 9.3125) });
  const sh = await Location.create({ name: 'Sheikh Hussein', type: 'area', parentId: harar._id, code: 'HAR-SH', coordinates: point(42.0500, 9.2500) });
  const erer = await Location.create({ name: 'Erer', type: 'area', parentId: harar._id, code: 'HAR-ER', coordinates: point(42.1500, 9.4000) });
  const s01 = await Location.create({ name: 'Sector 01', type: 'sector', parentId: sh._id, code: 'HAR-SH-01', coordinates: point(42.1200, 9.3100) });
  const s02 = await Location.create({ name: 'Sector 02', type: 'sector', parentId: sh._id, code: 'HAR-SH-02', coordinates: point(42.1400, 9.3000) });
  const s03 = await Location.create({ name: 'Sector 03', type: 'sector', parentId: erer._id, code: 'HAR-ER-01', coordinates: point(42.1600, 9.4100) });
  const commA = await Location.create({ name: 'Community A', type: 'community', parentId: s01._id, code: 'HAR-SH-01-A', coordinates: point(42.1150, 9.3150) });
  const commB = await Location.create({ name: 'Community B', type: 'community', parentId: s01._id, code: 'HAR-SH-01-B', coordinates: point(42.1350, 9.3250) });
  const ddCity = await Location.create({ name: 'Dire Dawa City', type: 'city', parentId: direDawa._id, code: 'DD-C', coordinates: point(41.8661, 9.5931) });
  const kezira = await Location.create({ name: 'Kezira', type: 'area', parentId: ddCity._id, code: 'DD-KZ', coordinates: point(41.8400, 9.5700) });

  const hararZone = await Zone.create({
    name: 'Harar City Zone', code: 'HZ-CITY', sectorId: s01._id,
    locationIds: [harar._id, sh._id, erer._id, s01._id, s02._id, s03._id],
    coverage: coverage(42.1256, 9.3125, 12),
  });
  const commZone = await Zone.create({
    name: 'Harar Community Zone', code: 'HZ-COMM', sectorId: s01._id,
    locationIds: [commA._id, commB._id, s01._id],
    coverage: coverage(42.1250, 9.3200, 6),
  });
  const ddZone = await Zone.create({
    name: 'Dire Dawa Zone', code: 'DD-ZONE', sectorId: s03._id,
    locationIds: [ddCity._id, kezira._id],
    coverage: coverage(41.8661, 9.5931, 15),
  });

  const localSvc = await DeliveryService.create({ name: 'Local Delivery', code: 'SVC-LOCAL', coverageZones: [hararZone._id], baseFee: 50, perKmFee: 10 });
  const interSvc = await DeliveryService.create({ name: 'Intercity Delivery', code: 'SVC-INTER', coverageZones: [hararZone._id, ddZone._id], baseFee: 200, perKmFee: 20, serviceType: 'next_day' });

  await Provider.create({ name: 'Ahmed Ali', phone: '+251911111111', email: 'ahmed@aritii.et', status: 'available', actorType: 'rider', plateNumber: 'ET-MC-001', sectorId: s01._id, availability: { isOnline: true }, serviceId: localSvc._id, zoneId: hararZone._id, zoneIds: [hararZone._id, commZone._id], vehicleType: 'motorcycle', maxCapacityKg: 20 });
  await Provider.create({ name: 'Fatima Hassan', phone: '+251922222222', email: 'fatima@aritii.et', status: 'available', actorType: 'rider', plateNumber: 'ET-BC-002', sectorId: s01._id, availability: { isOnline: true }, serviceId: localSvc._id, zoneId: commZone._id, zoneIds: [commZone._id, hararZone._id], vehicleType: 'bicycle', maxCapacityKg: 10 });
  await Provider.create({ name: 'Omar Ibrahim', phone: '+251933333333', email: 'omar@aritii.et', status: 'available', actorType: 'driver', plateNumber: 'ET-VN-003', sectorId: s03._id, availability: { isOnline: true }, serviceId: interSvc._id, zoneId: ddZone._id, zoneIds: [ddZone._id], vehicleType: 'van', maxCapacityKg: 100 });

  await Hub.create({ name: 'Harar Hub', locationId: harar._id, capacity: 200, contactPhone: '+251900000001' });
  await Hub.create({ name: 'Dire Dawa Hub', locationId: ddCity._id, capacity: 150, contactPhone: '+251900000002' });

  await DeliveryRoute.create({ name: 'Harar City Loop', originLocationId: harar._id, destinationLocationId: harar._id, distanceKm: 15, estimatedDurationMinutes: 45 });
  await DeliveryRoute.create({ name: 'Harar → Dire Dawa', originLocationId: harar._id, destinationLocationId: ddCity._id, distanceKm: 55, estimatedDurationMinutes: 180 });
  await DeliveryRoute.create({ name: 'Sector 01 → Kezira', originLocationId: s01._id, destinationLocationId: kezira._id, distanceKm: 145, estimatedDurationMinutes: 180 });

  console.log('[seed] Completed:');
  console.log(`  ${await Location.countDocuments()} locations`);
  console.log(`  ${await Zone.countDocuments()} zones`);
  console.log(`  ${await DeliveryService.countDocuments()} delivery services`);
  console.log(`  ${await Provider.countDocuments()} providers`);
  console.log(`  ${await Hub.countDocuments()} hubs`);
  console.log(`  ${await DeliveryRoute.countDocuments()} routes`);

  await mongoose.disconnect();
}

seed().catch((err) => { console.error('[seed] Error:', err); process.exit(1); });
