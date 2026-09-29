const mongoose = require('mongoose');
const Sector = require('../../modules/selling/models/Sectors');
const Shop = require('../../modules/selling/models/Shops');
const Order = require('../../modules/fulfillment/models/Orders');
const { seedShops } = require('./shops.data');
const { seedOrders } = require('./orders.data');
const locationResolver = require('../../shared/utils/locationResolver');

async function seedHarariRegion() {
  console.log('[harari] Clearing existing data...');
  await Sector.deleteMany({});
  await Shop.deleteMany({});
  await Order.deleteMany({});

  // Fetch Harar sectors from delivery-service
  console.log('[harari] Fetching Harar location data from delivery-service...');
  const harariSectors = await locationResolver.getHarariSectors();

  if (harariSectors.length === 0) {
    console.warn('[harari] No Harar sectors found in delivery-service. Using defaults.');
  }

  // Resolve full location hierarchy for sectors
  const sectorHierarchyMap = new Map();
  for (const sector of harariSectors) {
    const path = await locationResolver.getLocationWithPath(sector._id);
    if (path.location && path.ancestors) {
      const hierarchy = { sectorId: sector._id, sectorName: sector.name };
      for (const ancestor of path.ancestors) {
        if (ancestor.type === 'area') { hierarchy.areaId = ancestor._id; hierarchy.areaName = ancestor.name; }
        if (ancestor.type === 'city') { hierarchy.cityId = ancestor._id; hierarchy.cityName = ancestor.name; }
        if (ancestor.type === 'region') { hierarchy.regionId = ancestor._id; hierarchy.regionName = ancestor.name; }
      }
      sectorHierarchyMap.set(String(sector._id), hierarchy);
    }
  }

  console.log('[harari] Creating sectors...');
  const sectors = await Sector.insertMany([
    {
      name: 'Sector 1 - Sheikh Hussein',
      city: 'Harar',
      description: 'Food & Grocery - Central Area',
      deliveryFee: 50,
      estimatedDeliveryTime: 45,
      isActive: true,
    },
    {
      name: 'Sector 2 - Erer',
      city: 'Harar',
      description: 'Pharmacy & Health - Residential',
      deliveryFee: 40,
      estimatedDeliveryTime: 35,
      isActive: true,
    },
    {
      name: 'Sector 3 - Falls',
      city: 'Harar',
      description: 'Fashion & Clothing - Market',
      deliveryFee: 60,
      estimatedDeliveryTime: 50,
      isActive: true,
    },
    {
      name: 'Sector 4 - Sami',
      city: 'Harar',
      description: 'Electronics & Tech - Downtown',
      deliveryFee: 70,
      estimatedDeliveryTime: 60,
      isActive: true,
    },
  ]);

  console.log(`[harari] ✅ ${sectors.length} sectors created`);

  console.log('[harari] Creating shops with location mapping...');
  const shopsWithLocation = seedShops.map((shop, idx) => {
    const sector = sectors[idx % sectors.length];
    const deliverySector = harariSectors[idx % harariSectors.length];
    const sectorId = deliverySector ? String(deliverySector._id) : null;
    const hierarchy = sectorId ? sectorHierarchyMap.get(sectorId) : null;

    return {
      ...shop,
      sectorId: sector._id.toString(),
      locationId: deliverySector ? deliverySector._id.toString() : null,
      locationSnapshot: hierarchy ? {
        regionId: hierarchy.regionId || null,
        regionName: hierarchy.regionName || '',
        areaId: hierarchy.areaId || null,
        areaName: hierarchy.areaName || '',
        cityId: hierarchy.cityId || null,
        cityName: hierarchy.cityName || '',
        sectorId: hierarchy.sectorId || null,
        sectorName: hierarchy.sectorName || '',
        fullAddress: shop.address || '',
        landmark: '', building: '',
        contactPhone: String(shop.phoneNumber || ''),
        coordinates: { latitude: null, longitude: null },
        resolvedAt: new Date(),
      } : null,
    };
  });

  const shops = await Shop.insertMany(shopsWithLocation);
  console.log(`[harari] ✅ ${shops.length} shops created`);

  console.log('[harari] Creating orders with location tracking...');
  const ordersWithLocation = seedOrders.map((order, idx) => {
    const shop = shops[idx % shops.length];
    const sector = sectors[idx % sectors.length];

    // Build seller shipment from shop's location snapshot
    const origin = shop.locationSnapshot ? {
      regionId: shop.locationSnapshot.regionId,
      regionName: shop.locationSnapshot.regionName,
      areaId: shop.locationSnapshot.areaId,
      areaName: shop.locationSnapshot.areaName,
      cityId: shop.locationSnapshot.cityId,
      cityName: shop.locationSnapshot.cityName,
      sectorId: shop.locationSnapshot.sectorId,
      sectorName: shop.locationSnapshot.sectorName,
      fullAddress: shop.locationSnapshot.fullAddress,
      landmark: shop.locationSnapshot.landmark,
      building: shop.locationSnapshot.building,
      contactPhone: shop.locationSnapshot.contactPhone,
      coordinates: shop.locationSnapshot.coordinates,
    } : {
      regionId: null, regionName: '', areaId: null, areaName: '',
      cityId: null, cityName: '', sectorId: null, sectorName: '',
      fullAddress: shop.address || '', landmark: '', building: '',
      contactPhone: String(shop.phoneNumber || ''),
      coordinates: { latitude: null, longitude: null },
    };

    return {
      ...order,
      sellerId: shop.ownerId,
      sectorId: order.destination?.sectorId || sector._id.toString(),
      locationId: order.destination?.sectorId || shop.locationId,
      sellerShipments: [{
        sellerId: shop.ownerId,
        businessId: shop.ownerId,
        shopId: shop._id.toString(),
        items: order.cart || [],
        subtotal: order.totalPrice || 0,
        origin,
      }],
    };
  });

  const orders = await Order.insertMany(ordersWithLocation);
  console.log(`[harari] ✅ ${orders.length} orders created`);

  return { sectors, shops, orders };
}

module.exports = { seedHarariRegion };
