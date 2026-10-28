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

const stats = { created: 0, reused: 0 };

/**
 * Upsert with attribute updates:
 * If document exists, update its attributes to keep seeded configuration fresh
 * while preserving its _id so existing foreign keys do not break.
 */
async function upsert(Model, filter, values) {
  const existing = await Model.findOne(filter);
  if (existing) {
    stats.reused += 1;
    await Model.updateOne(filter, { $set: values });
    return Model.findOne(filter);
  }
  stats.created += 1;
  return Model.create({ ...values, ...filter });
}

async function seed({ uri = MONGODB_URI, connect = true, reset = false } = {}) {
  if (connect) await mongoose.connect(uri);
  stats.created = 0;
  stats.reused = 0;

  if (reset) {
    console.log('[delivery-seed] Reset requested — clearing previous delivery seed records...');
    await Provider.deleteMany({});
    await DeliveryRoute.deleteMany({});
    await Port.deleteMany({});
    await DeliveryService.deleteMany({});
    await Zone.deleteMany({});
    await Location.deleteMany({});
  }

  // ── 1. Location Hierarchy ──────────────────────────────────────────────────
  // Country
  const ethiopia = await upsert(
    Location,
    { code: 'ET' },
    {
      name: 'Ethiopia',
      localName: 'ኢትዮጵያ',
      type: 'country',
      coordinates: point(40.4897, 9.1450),
      isActive: true,
      serviceability: { serviceable: true, deliveryAvailable: true, codAvailable: true },
    }
  );

  // Regions
  const hararghe = await upsert(
    Location,
    { code: 'HR' },
    {
      name: 'Hararghe',
      localName: 'ሐረሪ ክልል',
      type: 'region',
      parentId: ethiopia._id,
      coordinates: point(42.0, 9.2),
      isActive: true,
      serviceability: { serviceable: true, deliveryAvailable: true, codAvailable: true },
    }
  );

  const direDawa = await upsert(
    Location,
    { code: 'DD' },
    {
      name: 'Dire Dawa',
      localName: 'ድሬዳዋ አስተዳደር',
      type: 'region',
      parentId: ethiopia._id,
      coordinates: point(41.8661, 9.5931),
      isActive: true,
      serviceability: { serviceable: true, deliveryAvailable: true, codAvailable: true },
    }
  );

  const addis = await upsert(
    Location,
    { code: 'AA' },
    {
      name: 'Addis Ababa',
      localName: 'አዲስ አበባ',
      type: 'city',
      parentId: ethiopia._id,
      coordinates: point(38.7525, 9.0192),
      isActive: true,
      serviceability: { serviceable: true, deliveryAvailable: true, codAvailable: true },
    }
  );

  // Cities
  const harar = await upsert(
    Location,
    { code: 'HAR' },
    {
      name: 'Harar',
      localName: 'ሐረር',
      type: 'city',
      parentId: hararghe._id,
      coordinates: point(42.1256, 9.3125),
      isActive: true,
      serviceability: {
        serviceable: true,
        deliveryAvailable: true,
        pickupAvailable: true,
        codAvailable: true,
        estimatedDeliveryTime: '30-45 min',
        deliveryFee: 50,
      },
    }
  );

  const ddCity = await upsert(
    Location,
    { code: 'DD-C' },
    {
      name: 'Dire Dawa City',
      localName: 'ድሬዳዋ ከተማ',
      type: 'city',
      parentId: direDawa._id,
      coordinates: point(41.8661, 9.5931),
      isActive: true,
      serviceability: {
        serviceable: true,
        deliveryAvailable: true,
        pickupAvailable: true,
        codAvailable: true,
        estimatedDeliveryTime: '30-45 min',
        deliveryFee: 50,
      },
    }
  );

  // Sub-locations / Sectors under Harar (type: 'other')
  const hararSectors = [
    { code: 'HAR-JUG', name: 'Jugol (Historic Walled City)', localName: 'ጀጎል', coordinates: point(42.1280, 9.3110) },
    { code: 'HAR-ABD', name: 'Abadir', localName: 'አባዲር', coordinates: point(42.1150, 9.3180) },
    { code: 'HAR-SHK', name: 'Shenkor', localName: 'ሸንኮር', coordinates: point(42.1350, 9.3050) },
    { code: 'HAR-AMN', name: 'Amir Nur', localName: 'አሚር ኑር', coordinates: point(42.1200, 9.3150) },
    { code: 'HAR-HAK', name: 'Hakim', localName: 'ሀኪም', coordinates: point(42.1400, 9.3250) },
    { code: 'HAR-JIN', name: 'Jin\'Eala', localName: 'ጂንኤላ', coordinates: point(42.1260, 9.3140) },
  ];

  const seededHararSectors = [];
  for (const s of hararSectors) {
    const loc = await upsert(
      Location,
      { code: s.code },
      {
        name: s.name,
        localName: s.localName,
        type: 'other',
        parentId: harar._id,
        coordinates: s.coordinates,
        isActive: true,
        serviceability: { serviceable: true, deliveryAvailable: true, codAvailable: true, pickupAvailable: true },
      }
    );
    seededHararSectors.push(loc);
  }

  // Sub-locations / Kebeles under Dire Dawa City (type: 'other')
  const ddSectors = [
    { code: 'DD-KAZ', name: 'Kazira', localName: 'ካዚራ', coordinates: point(41.8700, 9.5950) },
    { code: 'DD-SAB', name: 'Sabian', localName: 'ሳቢያን', coordinates: point(41.8500, 9.6000) },
    { code: 'DD-MEG', name: 'Megala', localName: 'መጋላ', coordinates: point(41.8650, 9.5850) },
    { code: 'DD-K01', name: 'Kebele 01 / Gey Gira', localName: 'ቀበሌ 01', coordinates: point(41.8600, 9.5900) },
    { code: 'DD-DEC', name: 'Dechatu', localName: 'ደቻቱ', coordinates: point(41.8550, 9.5920) },
    { code: 'DD-GND', name: 'Gende Kore', localName: 'ገንደ ቆሬ', coordinates: point(41.8750, 9.6100) },
  ];

  const seededDdSectors = [];
  for (const s of ddSectors) {
    const loc = await upsert(
      Location,
      { code: s.code },
      {
        name: s.name,
        localName: s.localName,
        type: 'other',
        parentId: ddCity._id,
        coordinates: s.coordinates,
        isActive: true,
        serviceability: { serviceable: true, deliveryAvailable: true, codAvailable: true, pickupAvailable: true },
      }
    );
    seededDdSectors.push(loc);
  }

  // ── 2. Delivery Zones ───────────────────────────────────────────────────────
  const hararLocationIds = [harar._id, ...seededHararSectors.map((s) => s._id)];
  const ddLocationIds = [ddCity._id, ...seededDdSectors.map((s) => s._id)];

  const hararZone = await upsert(Zone, { code: 'HZ-CITY' }, {
    name: 'Harar City Zone',
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: hararLocationIds,
    coverage: coverage(42.1256, 9.3125, 12),
    deliveryRules: {
      serviceable: true,
      deliveryFee: 50,
      estimatedDeliveryTime: '30-45 min',
      codAvailable: true,
      pickupAvailable: true,
      quantityFees: [
        { minQty: 1, maxQty: 3, fee: 50, enabled: true, label: 'Standard Delivery (1-3 items)' },
        { minQty: 4, maxQty: 10, fee: 80, enabled: true, label: 'Medium Parcel (4-10 items)' },
        { minQty: 11, fee: 120, enabled: true, label: 'Bulk Order (11+ items)' },
      ],
    },
  });

  const jugolSector = seededHararSectors.find((s) => s.code === 'HAR-JUG') || harar;
  const oldTownZone = await upsert(Zone, { code: 'HZ-COMM' }, {
    name: 'Harar Old Town Zone',
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: [harar._id, jugolSector._id],
    coverage: coverage(42.1250, 9.3200, 6),
    deliveryRules: {
      serviceable: true,
      deliveryFee: 40,
      estimatedDeliveryTime: '20-35 min',
      codAvailable: true,
      pickupAvailable: true,
      quantityFees: [
        { minQty: 1, maxQty: 3, fee: 40, enabled: true, label: 'Jugol Express (1-3 items)' },
        { minQty: 4, maxQty: 10, fee: 70, enabled: true, label: 'Jugol Medium (4-10 items)' },
        { minQty: 11, fee: 100, enabled: true, label: 'Jugol Bulk (11+ items)' },
      ],
    },
  });

  const ddZone = await upsert(Zone, { code: 'DD-ZONE' }, {
    name: 'Dire Dawa Zone',
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: ddLocationIds,
    coverage: coverage(41.8661, 9.5931, 15),
    deliveryRules: {
      serviceable: true,
      deliveryFee: 55,
      estimatedDeliveryTime: '30-50 min',
      codAvailable: true,
      pickupAvailable: true,
      quantityFees: [
        { minQty: 1, maxQty: 3, fee: 55, enabled: true, label: 'Standard Delivery (1-3 items)' },
        { minQty: 4, maxQty: 10, fee: 85, enabled: true, label: 'Medium Parcel (4-10 items)' },
        { minQty: 11, fee: 130, enabled: true, label: 'Bulk Order (11+ items)' },
      ],
    },
  });

  const sabianSector = seededDdSectors.find((s) => s.code === 'DD-SAB') || ddCity;
  const kaziraSector = seededDdSectors.find((s) => s.code === 'DD-KAZ') || ddCity;
  const ddSabianZone = await upsert(Zone, { code: 'DD-SABIAN' }, {
    name: 'Dire Dawa Sabian & Kazira Zone',
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: [ddCity._id, sabianSector._id, kaziraSector._id],
    coverage: coverage(41.8600, 9.5950, 10),
    deliveryRules: {
      serviceable: true,
      deliveryFee: 50,
      estimatedDeliveryTime: '25-45 min',
      codAvailable: true,
      pickupAvailable: true,
      quantityFees: [
        { minQty: 1, maxQty: 3, fee: 50, enabled: true, label: 'Commercial Express (1-3 items)' },
        { minQty: 4, maxQty: 10, fee: 80, enabled: true, label: 'Commercial Medium (4-10 items)' },
        { minQty: 11, fee: 120, enabled: true, label: 'Commercial Bulk (11+ items)' },
      ],
    },
  });

  const intercityZone = await upsert(Zone, { code: 'ET-HAR-DD-ZONE' }, {
    name: 'Harar - Dire Dawa Intercity Zone',
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: [...hararLocationIds, ...ddLocationIds],
    coverage: coverage(42.0, 9.45, 65),
    deliveryRules: {
      serviceable: true,
      deliveryFee: 180,
      estimatedDeliveryTime: '2-4 hours',
      codAvailable: true,
      pickupAvailable: false,
      quantityFees: [
        { minQty: 1, maxQty: 3, fee: 180, enabled: true, label: 'Intercity Express (1-3 items)' },
        { minQty: 4, maxQty: 10, fee: 280, enabled: true, label: 'Intercity Medium (4-10 items)' },
        { minQty: 11, fee: 400, enabled: true, label: 'Intercity Bulk (11+ items)' },
      ],
    },
  });

  const aaZone = await upsert(Zone, { code: 'AA-ZONE' }, {
    name: 'Addis Ababa Central Zone',
    status: 'active',
    lifecycle: 'LIVE',
    locationIds: [addis._id],
    coverage: coverage(38.7525, 9.0192, 25),
    deliveryRules: {
      serviceable: true,
      deliveryFee: 65,
      estimatedDeliveryTime: '45-60 min',
      codAvailable: true,
      pickupAvailable: true,
      quantityFees: [
        { minQty: 1, maxQty: 3, fee: 65, enabled: true, label: 'Capital Express (1-3 items)' },
        { minQty: 4, maxQty: 10, fee: 95, enabled: true, label: 'Capital Medium (4-10 items)' },
        { minQty: 11, fee: 140, enabled: true, label: 'Capital Bulk (11+ items)' },
      ],
    },
  });

  // ── 3. Ports & Distribution Hubs ───────────────────────────────────────────
  const commAPort = await upsert(Port, { name: 'Central Market Port' }, {
    name: 'Central Market Port',
    locationId: harar._id,
    zoneId: oldTownZone._id,
    coordinates: { latitude: 9.3150, longitude: 42.1150 },
    capacity: 250,
    contactPhone: '+251911000001',
    status: 'active',
  });

  const commBPort = await upsert(Port, { name: 'Jugol Gate Port' }, {
    name: 'Jugol Gate Port',
    locationId: harar._id,
    zoneId: hararZone._id,
    coordinates: { latitude: 9.3250, longitude: 42.1350 },
    capacity: 200,
    contactPhone: '+251911000002',
    status: 'active',
  });

  const ddPort = await upsert(Port, { name: 'Bus Station Port' }, {
    name: 'Bus Station Port',
    locationId: ddCity._id,
    zoneId: ddZone._id,
    coordinates: { latitude: 9.5931, longitude: 41.8661 },
    capacity: 300,
    contactPhone: '+251911000003',
    status: 'active',
  });

  await upsert(Port, { locationId: harar._id, name: 'Harar Port' }, {
    name: 'Harar Port',
    locationId: harar._id,
    zoneId: hararZone._id,
    coordinates: { latitude: 9.3125, longitude: 42.1256 },
    capacity: 200,
    contactPhone: '+251900000001',
    status: 'active',
  });

  await upsert(Port, { locationId: ddCity._id, name: 'Dire Dawa Port' }, {
    name: 'Dire Dawa Port',
    locationId: ddCity._id,
    zoneId: ddZone._id,
    coordinates: { latitude: 9.5931, longitude: 41.8661 },
    capacity: 250,
    contactPhone: '+251900000002',
    status: 'active',
  });

  // ── 4. Delivery Services ───────────────────────────────────────────────────
  const localSvc = await upsert(DeliveryService, { code: 'SVC-LOCAL' }, {
    name: 'Harar Local Delivery',
    coverageZones: [hararZone._id, oldTownZone._id],
    baseFee: 50,
    perKmFee: 10,
    serviceType: 'same_day',
    status: 'active',
  });

  const ddLocalSvc = await upsert(DeliveryService, { code: 'SVC-DD-LOCAL' }, {
    name: 'Dire Dawa Local Delivery',
    coverageZones: [ddZone._id, ddSabianZone._id],
    baseFee: 50,
    perKmFee: 10,
    serviceType: 'same_day',
    status: 'active',
  });

  const interSvc = await upsert(DeliveryService, { code: 'SVC-INTER' }, {
    name: 'Harar - Dire Dawa Intercity Delivery',
    coverageZones: [hararZone._id, ddZone._id, intercityZone._id],
    baseFee: 180,
    perKmFee: 15,
    serviceType: 'same_day',
    status: 'active',
  });

  // ── 5. Delivery Providers ──────────────────────────────────────────────────
  const seedProviders = [
    {
      name: 'Ahmed Ali',
      phone: '+251911111111',
      email: 'ahmed@aritii.et',
      actorType: 'rider',
      plateNumber: 'ET-MC-001',
      portId: commAPort._id,
      serviceId: localSvc._id,
      zoneId: hararZone._id,
      zoneIds: [hararZone._id, oldTownZone._id],
      vehicleType: 'motorcycle',
      maxCapacityKg: 25,
    },
    {
      name: 'Fatima Hassan',
      phone: '+251922222222',
      email: 'fatima@aritii.et',
      actorType: 'rider',
      plateNumber: 'ET-BC-002',
      portId: commBPort._id,
      serviceId: localSvc._id,
      zoneId: oldTownZone._id,
      zoneIds: [oldTownZone._id, hararZone._id],
      vehicleType: 'bicycle',
      maxCapacityKg: 12,
    },
    {
      name: 'Omar Ibrahim',
      phone: '+251933333333',
      email: 'omar@aritii.et',
      actorType: 'driver',
      plateNumber: 'ET-VN-003',
      portId: ddPort._id,
      serviceId: interSvc._id,
      zoneId: intercityZone._id,
      zoneIds: [ddZone._id, hararZone._id, intercityZone._id],
      vehicleType: 'van',
      maxCapacityKg: 150,
    },
    {
      name: 'Bekele Tadesse',
      phone: '+251944444444',
      email: 'bekele@aritii.et',
      actorType: 'rider',
      plateNumber: 'ET-MC-004',
      portId: ddPort._id,
      serviceId: ddLocalSvc._id,
      zoneId: ddZone._id,
      zoneIds: [ddZone._id, ddSabianZone._id],
      vehicleType: 'motorcycle',
      maxCapacityKg: 25,
    },
    {
      name: 'Samira Mohammed',
      phone: '+251955555555',
      email: 'samira@aritii.et',
      actorType: 'rider',
      plateNumber: 'ET-MC-005',
      portId: ddPort._id,
      serviceId: ddLocalSvc._id,
      zoneId: ddSabianZone._id,
      zoneIds: [ddSabianZone._id, ddZone._id],
      vehicleType: 'motorcycle',
      maxCapacityKg: 20,
    },
  ];

  for (const provider of seedProviders) {
    await upsert(Provider, { phone: provider.phone }, {
      ...provider,
      status: 'available',
      availability: { isOnline: true },
    });
  }

  // ── 6. Delivery Routes ─────────────────────────────────────────────────────
  const routes = [
    { name: 'Harar City Loop', code: 'RT-HAR-LOOP', originLocationId: harar._id, destinationLocationId: harar._id, distanceKm: 15, estimatedDurationMinutes: 45 },
    { name: 'Dire Dawa City Loop', code: 'RT-DD-LOOP', originLocationId: ddCity._id, destinationLocationId: ddCity._id, distanceKm: 18, estimatedDurationMinutes: 50 },
    { name: 'Harar → Dire Dawa', code: 'RT-HAR-DD', originLocationId: harar._id, destinationLocationId: ddCity._id, distanceKm: 55, estimatedDurationMinutes: 120 },
    { name: 'Dire Dawa → Harar', code: 'RT-DD-HAR', originLocationId: ddCity._id, destinationLocationId: harar._id, distanceKm: 55, estimatedDurationMinutes: 120 },
    { name: 'Harar → Dire Dawa (via Port)', code: 'RT-HAR-PORT', originLocationId: harar._id, destinationLocationId: ddCity._id, distanceKm: 55, estimatedDurationMinutes: 130 },
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
    topLevel: addis._id ? 1 : 0,
    serviceIds: { local: String(localSvc._id), ddLocal: String(ddLocalSvc._id), intercity: String(interSvc._id) },
    zoneIds: {
      harar: String(hararZone._id),
      community: String(oldTownZone._id),
      direDawa: String(ddZone._id),
      ddSabian: String(ddSabianZone._id),
      intercity: String(intercityZone._id),
    },
    locationIds: {
      ethiopia: String(ethiopia._id),
      hararghe: String(hararghe._id),
      direDawa: String(direDawa._id),
      harar: String(harar._id),
      ddCity: String(ddCity._id),
      jugol: String(jugolSector._id),
      kazira: String(kaziraSector._id),
      sabian: String(sabianSector._id),
    },
  };

  if (connect) await mongoose.disconnect();
  return summary;
}

module.exports = { seed, upsert, point, coverage };

if (require.main === module) {
  const isReset = process.argv.includes('--reset');
  seed({ reset: isReset })
    .then((summary) => {
      console.log('[delivery-seed] Completed:');
      console.log(`  created ${summary.created} record(s), reused/updated ${summary.reused}`);
      console.log(`  ${summary.locations} locations, ${summary.zones} zones, ${summary.deliveryServices} delivery services`);
      console.log(`  ${summary.providers} providers, ${summary.ports} ports, ${summary.routes} routes`);
    })
    .catch((err) => { console.error('[delivery-seed] Error:', err); process.exit(1); });
}
