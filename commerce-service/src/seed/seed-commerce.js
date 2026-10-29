#!/usr/bin/env node
// Commerce Service seed — Real Categories, Real Shops, 60+ Real Products & Location-Validated Orders
// Usage:
//   docker exec -w /app/commerce-service aritii-commerce node src/seed/seed-commerce.js [--reset]

const mongoose = require('mongoose');
const Category = require('../modules/catalog/models/Categories');
const Shop = require('../modules/selling/models/Shops');
const Product = require('../modules/catalog/models/Products');
const Order = require('../modules/fulfillment/models/Orders');
const OrderDelivery = require('../modules/fulfillment/models/OrderDeliveries');
const SellerWallet = require('../modules/fulfillment/models/SellerWallet');
const SellerApplication = require('../modules/selling/models/SellerApplications');
const Cart = require('../modules/carts/models/Carts');
const Wishlist = require('../modules/carts/models/Wishlists');
const InventoryLedger = require('../modules/catalog/models/InventoryLedger');
const StockMovement = require('../modules/catalog/models/StockMovements');
const Conversation = require('../modules/chat/models/Conversation');
const Message = require('../modules/chat/models/Message');
const Request = require('../modules/requests/models/Requests');
const { ORDER_STATUSES } = require('../modules/fulfillment/constants/orderStatuses');
const { resolveShopBusinessId } = require('../modules/selling/services/business.service');
const { identityClient } = require('../app/clients/identity.client');
const orderDeliveryService = require('../modules/fulfillment/services/orderDelivery.service');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://admin:admin123@mongodb:27017/aritii?authSource=admin&replicaSet=rs0';

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  // Product categories
  {
    title: 'Ethiopian Coffee & Spices',
    description: 'Authentic single-origin Harar coffee beans, spiced berbere, mitmita, korarima, and traditional seasonings',
    type: 'product',
    sortOrder: 1,
    categoryImage: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Fresh Fruits & Vegetables',
    description: 'Fresh fruits, vegetables, organic honey, and dairy directly from eastern farms and oasis orchards',
    type: 'product',
    sortOrder: 2,
    categoryImage: 'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Grains & Pantry Staples',
    description: 'Organic Magna white teff, black cumin, fenugreek, organic lentils, and Ethiopian cereal grains',
    type: 'product',
    sortOrder: 3,
    categoryImage: 'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Traditional & Modern Fashion',
    description: 'Traditional Habesha kemis, handwoven gabi, scarves, and contemporary Ethiopian apparel',
    type: 'product',
    sortOrder: 4,
    categoryImage: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Leather Goods & Accessories',
    description: 'Genuine Ethiopian highland sheepskin and cowhide leather jackets, duffels, backpacks, and accessories',
    type: 'product',
    sortOrder: 5,
    categoryImage: 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Jewelry & Traditional Ornaments',
    description: 'Handcrafted Ethiopian silver crosses, amber and carnelian necklaces, filigree earrings, and bangles',
    type: 'product',
    sortOrder: 6,
    categoryImage: 'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Handcrafts & Cultural Artifacts',
    description: 'Handwoven Harari Mesob baskets, traditional crafts, hand-carved stools, and pottery',
    type: 'product',
    sortOrder: 7,
    categoryImage: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Home & Living',
    description: 'Traditional rekebot coffee tables, jebena clay pots, woven rugs, and Ethiopian artisanal decor',
    type: 'product',
    sortOrder: 8,
    categoryImage: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Beauty & Personal Care',
    description: 'Cold-pressed Ethiopian castor oil, qasil powder, natural beeswax balms, and herbal skincare',
    type: 'product',
    sortOrder: 9,
    categoryImage: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Electronics & Gadgets',
    description: 'Smartphones, laptops, audio accessories, fast chargers, and smart wearables',
    type: 'product',
    sortOrder: 10,
    categoryImage: 'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Books & Cultural Heritage',
    description: 'Ethiopian history, Geez manuscripts, cultural heritage literature, and languages',
    type: 'product',
    sortOrder: 11,
    categoryImage: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&w=600&q=80',
  },
  {
    title: 'Sports & Outdoors',
    description: 'Athletic apparel, distance running footwear, fitness gear, and camping equipment',
    type: 'product',
    sortOrder: 12,
    categoryImage: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?auto=format&fit=crop&w=600&q=80',
  },
  // Business categories
  { title: 'Retail', description: 'General retail and reselling businesses', type: 'business', sortOrder: 13 },
  { title: 'Food & Beverage', description: 'Restaurants, cafes, roasteries, and food services', type: 'business', sortOrder: 14 },
  { title: 'Fashion & Apparel', description: 'Traditional and contemporary fashion boutiques', type: 'business', sortOrder: 15 },
  { title: 'Crafts & Artisans', description: 'Handcrafted items, pottery, and cultural artifacts', type: 'business', sortOrder: 16 },
  { title: 'Agriculture & Produce', description: 'Farms, grains, organic honey, and produce', type: 'business', sortOrder: 17 },
  { title: 'Electronics & Technology', description: 'Consumer tech, mobile devices, and accessories', type: 'business', sortOrder: 18 },
  { title: 'Health & Beauty', description: 'Natural cosmetics, skincare, and herbal wellness', type: 'business', sortOrder: 19 },
];

// Helper to look up an Identity user with fallback
async function getSellerUserId(email, fallbackId) {
  try {
    const res = await identityClient.findUserByEmail(email);
    if (res.ok && res.body?.user?.id) {
      return res.body.user.id;
    }
  } catch (err) {
    console.warn(`[seed] Failed to fetch identity user for ${email}:`, err.message);
  }
  return fallbackId;
}

async function seed({ reset = false } = {}) {
  try {
    let dbName = process.env.COMMERCE_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME;
    if (!dbName) {
      const match = String(MONGO_URI).match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
      if (match && match[1] && match[1] !== 'test' && match[1] !== 'admin') {
        dbName = match[1];
      } else {
        dbName = 'aritii_commerce';
      }
    }
    await mongoose.connect(MONGO_URI, { dbName });
    console.log(`Connected to MongoDB database "${mongoose.connection.name}"`);

    const deliveryDb = mongoose.connection.client.db('aritii_delivery');
    const localLocationCount = await mongoose.connection.db.collection('locations').countDocuments().catch(() => 0);
    const locationsCol = localLocationCount > 0
      ? mongoose.connection.db.collection('locations')
      : deliveryDb.collection('locations');
    const localZoneCount = await mongoose.connection.db.collection('zones').countDocuments().catch(() => 0);
    const zonesCol = localZoneCount > 0
      ? mongoose.connection.db.collection('zones')
      : deliveryDb.collection('zones');

    // ── Fetch Delivery Locations & Zones ─────────────────────────────────────
    const locEthiopia = await locationsCol.findOne({ code: 'ET' });
    const locHararghe = await locationsCol.findOne({ code: 'HR' });
    const locDireDawaRegion = await locationsCol.findOne({ code: 'DD' });
    const locHararCity = await locationsCol.findOne({ code: 'HAR' });
    const locDdCity = await locationsCol.findOne({ code: 'DD-C' });
    const locAddis = (await locationsCol.findOne({ code: 'AA' })) || locEthiopia;

    const locJugol = (await locationsCol.findOne({ code: 'HAR-JUG' })) || locHararCity;
    const locAmirNur = (await locationsCol.findOne({ code: 'HAR-AMN' })) || locHararCity;
    const locAbadir = (await locationsCol.findOne({ code: 'HAR-ABD' })) || locHararCity;
    const locKazira = (await locationsCol.findOne({ code: 'DD-KAZ' })) || locDdCity;
    const locSabian = (await locationsCol.findOne({ code: 'DD-SAB' })) || locDdCity;
    const locMegala = (await locationsCol.findOne({ code: 'DD-MEG' })) || locDdCity;
    const locAshewa = (await locationsCol.findOne({ code: 'DD-ASH' })) || locDdCity;

    const zoneHararCity = await zonesCol.findOne({ code: 'HZ-CITY' });
    const zoneHararOldTown = (await zonesCol.findOne({ code: 'HZ-COMM' })) || zoneHararCity;
    const zoneDdCity = await zonesCol.findOne({ code: 'DD-ZONE' });
    const zoneDdSabian = (await zonesCol.findOne({ code: 'DD-SABIAN' })) || zoneDdCity;
    const zoneIntercity = (await zonesCol.findOne({ code: 'ET-HAR-DD-ZONE' })) || zoneHararCity;
    const zoneAddis = (await zonesCol.findOne({ code: 'AA-ZONE' })) || zoneIntercity;

    if (!locHararCity || !locDdCity || !zoneHararCity || !zoneDdCity) {
      throw new Error('Delivery locations and zones must be seeded first! Run delivery-service seed.');
    }

    if (reset) {
      console.log('\n── Reset requested: Clearing existing products, orders, shops, and auxiliary collections ──');
      await Order.deleteMany({});
      await OrderDelivery.deleteMany({});
      await Product.deleteMany({});
      await Shop.deleteMany({});
      await SellerApplication.deleteMany({});
      await SellerWallet.deleteMany({});
      await Category.deleteMany({});
      await Cart.deleteMany({});
      await Wishlist.deleteMany({});
      await InventoryLedger.deleteMany({});
      await StockMovement.deleteMany({});
      await Conversation.deleteMany({});
      await Message.deleteMany({});
      await Request.deleteMany({});
      console.log('  ✓ Cleared all commerce collections');
    }

    // ── 1. Seed Categories ───────────────────────────────────────────────────
    console.log('\n── Seeding Categories ──');
    const categoryMap = new Map();
    for (const cat of CATEGORIES) {
      const slug = cat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const existing = await Category.findOne({ title: cat.title });
      if (existing) {
        await Category.updateOne({ _id: existing._id }, { $set: { ...cat, slug } });
        categoryMap.set(cat.title, existing._id.toString());
        console.log(`  ✓ Updated category: ${cat.title} (${cat.type})`);
      } else {
        const created = await Category.create({ ...cat, slug });
        categoryMap.set(cat.title, created._id.toString());
        console.log(`  + Created category: ${cat.title} (${cat.type})`);
      }
    }

    // ── 2. Resolve Seller IDs from Identity Service ──────────────────────────
    console.log('\n── Resolving Seller Accounts ──');
    const sellerIds = {
      seller1: await getSellerUserId('seller1@aritii.com', 'seller1-id'),
      seller2: await getSellerUserId('seller2@aritii.com', 'seller2-id'),
      seller3: await getSellerUserId('seller3@aritii.com', 'seller3-id'),
      seller4: await getSellerUserId('seller4@aritii.com', 'seller4-id'),
      seller5: await getSellerUserId('seller5@aritii.com', 'seller5-id'),
      seller6: await getSellerUserId('seller6@aritii.com', 'seller6-id'),
      seller7: await getSellerUserId('seller7@aritii.com', 'seller7-id'),
      seller8: await getSellerUserId('seller8@aritii.com', 'seller8-id'),
      seller9: await getSellerUserId('seller9@aritii.com', 'seller9-id'),
      seller10: await getSellerUserId('seller10@aritii.com', 'seller10-id'),
    };
    console.log('  Resolved seller IDs:', sellerIds);

    // ── 3. Seed 10 Authentic Shops in Harar, Dire Dawa & Eastern Corridor ────
    console.log('\n── Seeding 10 Real Shops with Delivery Coverage & Branding ──');

    const SHOPS_DEF = [
      // 0: Harar Coffee & Spices
      {
        name: 'Harar Coffee Roastery & Spices',
        email: 'shop1@aritii.com',
        ownerId: sellerIds.seller1,
        description: 'Authentic Harar single-origin longberry coffee beans, stone-ground spiced berbere, mitmita, and traditional seasonings directly from Jugol historic market.',
        category: 'Food & Beverage',
        address: 'Jugol Gate, Old Walled City, Harar',
        phoneNumber: '+251911330001',
        zipCode: '10001',
        status: 'APPROVED',
        locationId: locHararCity._id.toString(),
        sectorId: locJugol._id.toString(),
        locationSnapshot: {
          regionId: locHararghe._id.toString(),
          regionName: 'Hararghe',
          cityId: locHararCity._id.toString(),
          cityName: 'Harar',
          areaId: locJugol._id.toString(),
          areaName: 'Jugol',
          sectorId: locJugol._id.toString(),
          sectorName: 'Jugol (Historic Walled City)',
          fullAddress: 'Jugol Gate, Old Walled City, Harar',
          landmark: 'Jugol Historic Gate',
          building: 'Heritage Roastery Building #4',
          contactPhone: '+251911330001',
          coordinates: { latitude: 9.3110, longitude: 42.1280 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneHararCity._id.toString(), zoneHararOldTown._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneHararCity._id.toString(), name: 'Harar City Zone' },
            { id: zoneHararOldTown._id.toString(), name: 'Harar Old Town Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_harar_coffee',
          url: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 1: Harar Heritage Crafts & Mesob
      {
        name: 'Harar Heritage Crafts & Mesob',
        email: 'shop2@aritii.com',
        ownerId: sellerIds.seller2,
        description: 'Master artisan handwoven Harari Mesob baskets, cultural wall decor, traditional carved acacia stools, and authentic decorative folk craft.',
        category: 'Crafts & Artisans',
        address: 'Artisan Square, Jugol, Harar',
        phoneNumber: '+251911330002',
        zipCode: '10002',
        status: 'APPROVED',
        locationId: locHararCity._id.toString(),
        sectorId: locJugol._id.toString(),
        locationSnapshot: {
          regionId: locHararghe._id.toString(),
          regionName: 'Hararghe',
          cityId: locHararCity._id.toString(),
          cityName: 'Harar',
          areaId: locJugol._id.toString(),
          areaName: 'Jugol',
          sectorId: locJugol._id.toString(),
          sectorName: 'Jugol (Historic Walled City)',
          fullAddress: 'Artisan Square, Jugol, Harar',
          landmark: 'Jugol Central Market Square',
          building: 'Artisan Guild House #12',
          contactPhone: '+251911330002',
          coordinates: { latitude: 9.3125, longitude: 42.1256 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneHararCity._id.toString(), zoneHararOldTown._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneHararCity._id.toString(), name: 'Harar City Zone' },
            { id: zoneHararOldTown._id.toString(), name: 'Harar Old Town Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_harar_crafts',
          url: 'https://images.unsplash.com/photo-1606760227091-3dd870d97f1d?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 2: Ras Makonnen Leatherworks (Harar)
      {
        name: 'Ras Makonnen Traditional Leatherworks',
        email: 'shop6@aritii.com',
        ownerId: sellerIds.seller6,
        description: 'Exquisite genuine Ethiopian highland calfskin and sheepskin leather bags, duffels, wallets, belts, and artisanal leather footwear.',
        category: 'Fashion & Apparel',
        address: 'Amir Nur Commercial District, Harar',
        phoneNumber: '+251911330006',
        zipCode: '10006',
        status: 'APPROVED',
        locationId: locHararCity._id.toString(),
        sectorId: locAmirNur._id.toString(),
        locationSnapshot: {
          regionId: locHararghe._id.toString(),
          regionName: 'Hararghe',
          cityId: locHararCity._id.toString(),
          cityName: 'Harar',
          areaId: locAmirNur._id.toString(),
          areaName: 'Amir Nur',
          sectorId: locAmirNur._id.toString(),
          sectorName: 'Amir Nur',
          fullAddress: 'Amir Nur Commercial District, Harar',
          landmark: 'Ras Makonnen Memorial Avenue',
          building: 'Tannery Craft Center #8',
          contactPhone: '+251911330006',
          coordinates: { latitude: 9.3150, longitude: 42.1200 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneHararCity._id.toString(), zoneHararOldTown._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneHararCity._id.toString(), name: 'Harar City Zone' },
            { id: zoneHararOldTown._id.toString(), name: 'Harar Old Town Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_ras_makonnen_leather',
          url: 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 3: Abadir Heritage Silver & Jewelry (Harar)
      {
        name: 'Abadir Heritage Silver & Jewelry',
        email: 'shop8@aritii.com',
        ownerId: sellerIds.seller8,
        description: 'Fine handcrafted Ethiopian Coptic crosses, filigree earrings, antique amber and carnelian necklaces, and bespoke silver bridal jewelry.',
        category: 'Retail',
        address: 'Abadir Silversmiths Row, Harar',
        phoneNumber: '+251911330008',
        zipCode: '10008',
        status: 'APPROVED',
        locationId: locHararCity._id.toString(),
        sectorId: locAbadir._id.toString(),
        locationSnapshot: {
          regionId: locHararghe._id.toString(),
          regionName: 'Hararghe',
          cityId: locHararCity._id.toString(),
          cityName: 'Harar',
          areaId: locAbadir._id.toString(),
          areaName: 'Abadir',
          sectorId: locAbadir._id.toString(),
          sectorName: 'Abadir',
          fullAddress: 'Abadir Silversmiths Row, Harar',
          landmark: 'Abadir Central Square',
          building: 'Silver Guild Workshop 3',
          contactPhone: '+251911330008',
          coordinates: { latitude: 9.3180, longitude: 42.1150 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneHararCity._id.toString(), zoneHararOldTown._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneHararCity._id.toString(), name: 'Harar City Zone' },
            { id: zoneHararOldTown._id.toString(), name: 'Harar Old Town Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_abadir_silver',
          url: 'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 4: Dire Dawa Oasis Farm Fresh
      {
        name: 'Dire Dawa Oasis Farm Fresh',
        email: 'shop3@aritii.com',
        ownerId: sellerIds.seller3,
        description: 'Naturally grown tropical fruits, ripe papayas, mangoes, pure raw forest honey, cold-pressed sesame oil, and organic garden produce.',
        category: 'Agriculture & Produce',
        address: 'Megala Central Market, Dire Dawa',
        phoneNumber: '+251911330003',
        zipCode: '10003',
        status: 'APPROVED',
        locationId: locDdCity._id.toString(),
        sectorId: locMegala._id.toString(),
        locationSnapshot: {
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          areaId: locMegala._id.toString(),
          areaName: 'Megala',
          sectorId: locMegala._id.toString(),
          sectorName: 'Megala',
          fullAddress: 'Megala Central Market, Dire Dawa',
          landmark: 'Old Market Square',
          building: 'Fresh Produce Stalls 1-4',
          contactPhone: '+251911330003',
          coordinates: { latitude: 9.5850, longitude: 41.8650 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneDdCity._id.toString(), zoneDdSabian._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneDdCity._id.toString(), name: 'Dire Dawa Zone' },
            { id: zoneDdSabian._id.toString(), name: 'Dire Dawa Sabian & Kazira Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_dd_farm_fresh',
          url: 'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 5: Dire Dawa Smart Tech Electronics
      {
        name: 'Dire Dawa Smart Tech Electronics',
        email: 'shop4@aritii.com',
        ownerId: sellerIds.seller4,
        description: 'Genuine brand smartphones, laptops, active noise cancelling headphones, fast GaN chargers, and high-capacity power banks.',
        category: 'Electronics & Technology',
        address: 'Kazira Commercial Boulevard, Dire Dawa',
        phoneNumber: '+251911330004',
        zipCode: '10004',
        status: 'APPROVED',
        locationId: locDdCity._id.toString(),
        sectorId: locKazira._id.toString(),
        locationSnapshot: {
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          areaId: locKazira._id.toString(),
          areaName: 'Kazira',
          sectorId: locKazira._id.toString(),
          sectorName: 'Kazira',
          fullAddress: 'Kazira Commercial Boulevard, Dire Dawa',
          landmark: 'Opposite Historic Railway Station',
          building: 'Kazira Tech Mall, Ground Floor',
          contactPhone: '+251911330004',
          coordinates: { latitude: 9.5950, longitude: 41.8700 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneDdCity._id.toString(), zoneDdSabian._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneDdCity._id.toString(), name: 'Dire Dawa Zone' },
            { id: zoneDdSabian._id.toString(), name: 'Dire Dawa Sabian & Kazira Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_dd_smart_tech',
          url: 'https://images.unsplash.com/photo-1550009158-9ebf69173e03?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 6: Sabian Modern & Cultural Fashion
      {
        name: 'Sabian Modern & Cultural Fashion',
        email: 'shop5@aritii.com',
        ownerId: sellerIds.seller5,
        description: 'Handwoven Habesha kemis with Tibeb embroidery, four-layer cotton gabi blankets, Netela shawls, and contemporary linen apparel.',
        category: 'Fashion & Apparel',
        address: 'Sabian High Street, Dire Dawa',
        phoneNumber: '+251911330005',
        zipCode: '10005',
        status: 'APPROVED',
        locationId: locDdCity._id.toString(),
        sectorId: locSabian._id.toString(),
        locationSnapshot: {
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          areaId: locSabian._id.toString(),
          areaName: 'Sabian',
          sectorId: locSabian._id.toString(),
          sectorName: 'Sabian',
          fullAddress: 'Sabian High Street, Dire Dawa',
          landmark: 'Sabian Commercial Center',
          building: 'Sabian Fashion House, Suite 2B',
          contactPhone: '+251911330005',
          coordinates: { latitude: 9.6000, longitude: 41.8500 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneDdCity._id.toString(), zoneDdSabian._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneDdCity._id.toString(), name: 'Dire Dawa Zone' },
            { id: zoneDdSabian._id.toString(), name: 'Dire Dawa Sabian & Kazira Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_sabian_fashion',
          url: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 7: Awash Valley Spices & Grain Trading (Dire Dawa)
      {
        name: 'Awash Valley Spices & Grain Trading',
        email: 'shop7@aritii.com',
        ownerId: sellerIds.seller7,
        description: 'Premium Magna white and brown teff grain, black cumin (Tikur Azmud), fenugreek (Abish), whole lentils, and culinary seeds from the Rift Valley.',
        category: 'Agriculture & Produce',
        address: 'Ashewa Grain Terminal, Dire Dawa',
        phoneNumber: '+251911330007',
        zipCode: '10007',
        status: 'APPROVED',
        locationId: locDdCity._id.toString(),
        sectorId: locAshewa._id.toString(),
        locationSnapshot: {
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          areaId: locAshewa._id.toString(),
          areaName: 'Ashewa',
          sectorId: locAshewa._id.toString(),
          sectorName: 'Ashewa',
          fullAddress: 'Ashewa Grain Terminal, Dire Dawa',
          landmark: 'Ashewa Freight Depot',
          building: 'Warehouse Block B-14',
          contactPhone: '+251911330007',
          coordinates: { latitude: 9.5880, longitude: 41.8750 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneDdCity._id.toString(), zoneDdSabian._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneDdCity._id.toString(), name: 'Dire Dawa Zone' },
            { id: zoneDdSabian._id.toString(), name: 'Dire Dawa Sabian & Kazira Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_awash_grain',
          url: 'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 8: Sheger Home Living & Artisanal Decor
      {
        name: 'Sheger Home Living & Artisanal Decor',
        email: 'shop9@aritii.com',
        ownerId: sellerIds.seller9,
        description: 'Traditional Ethiopian polished wooden Rekebot coffee tables, authentic clay Jebena pots, terracotta mabkheya incense burners, and artisan home accents.',
        category: 'Crafts & Artisans',
        address: 'Kazira Arts Corner, Dire Dawa',
        phoneNumber: '+251911330009',
        zipCode: '10009',
        status: 'APPROVED',
        locationId: locDdCity._id.toString(),
        sectorId: locKazira._id.toString(),
        locationSnapshot: {
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          areaId: locKazira._id.toString(),
          areaName: 'Kazira',
          sectorId: locKazira._id.toString(),
          sectorName: 'Kazira',
          fullAddress: 'Kazira Arts Corner, Dire Dawa',
          landmark: 'Kazira Cultural Plaza',
          building: 'Sheger Design Studio',
          contactPhone: '+251911330009',
          coordinates: { latitude: 9.5960, longitude: 41.8680 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneDdCity._id.toString(), zoneDdSabian._id.toString(), zoneHararCity._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneDdCity._id.toString(), name: 'Dire Dawa Zone' },
            { id: zoneDdSabian._id.toString(), name: 'Dire Dawa Sabian & Kazira Zone' },
            { id: zoneHararCity._id.toString(), name: 'Harar City Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_sheger_living',
          url: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=400&q=80',
        },
      },
      // 9: Highland Pure Organics & Herbal Care
      {
        name: 'Highland Pure Organics & Herbal Care',
        email: 'shop10@aritii.com',
        ownerId: sellerIds.seller10,
        description: 'Cold-pressed Ethiopian black castor oil, natural qasil leaf skin powder, beeswax balms, frankincense recovery salves, and pure moringa oil.',
        category: 'Health & Beauty',
        address: 'Sabian Botanical Center, Dire Dawa',
        phoneNumber: '+251911330010',
        zipCode: '10010',
        status: 'APPROVED',
        locationId: locDdCity._id.toString(),
        sectorId: locSabian._id.toString(),
        locationSnapshot: {
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          areaId: locSabian._id.toString(),
          areaName: 'Sabian',
          sectorId: locSabian._id.toString(),
          sectorName: 'Sabian',
          fullAddress: 'Sabian Botanical Center, Dire Dawa',
          landmark: 'Sabian Gardens',
          building: 'Herbal Wellness Pavilion #5',
          contactPhone: '+251911330010',
          coordinates: { latitude: 9.6010, longitude: 41.8520 },
          resolvedAt: new Date(),
        },
        deliveryCoverage: {
          status: 'ACTIVE',
          source: 'ADMIN',
          zoneIds: [zoneDdCity._id.toString(), zoneDdSabian._id.toString(), zoneIntercity._id.toString()],
          zoneNames: [
            { id: zoneDdCity._id.toString(), name: 'Dire Dawa Zone' },
            { id: zoneDdSabian._id.toString(), name: 'Dire Dawa Sabian & Kazira Zone' },
            { id: zoneIntercity._id.toString(), name: 'Harar - Dire Dawa Intercity Zone' },
          ],
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
        avatar: {
          public_id: 'shop_highland_organics',
          url: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=400&q=80',
        },
      },
    ];

    const shops = [];
    for (const shopDef of SHOPS_DEF) {
      let shop = await Shop.findOne({ email: shopDef.email });
      if (shop) {
        await Shop.updateOne({ _id: shop._id }, { $set: shopDef });
        shop = await Shop.findById(shop._id);
        console.log(`  ✓ Updated shop: ${shop.name} (${shop._id})`);
      } else {
        shop = await Shop.create(shopDef);
        console.log(`  + Created shop: ${shop.name} (${shop._id})`);
      }

      // Link business application
      if (shop.ownerId) {
        await resolveShopBusinessId(shop);
        try {
          await identityClient.linkShopId(shop.ownerId, shop._id.toString());
        } catch (_) {}

        try {
          const existingWallet = await SellerWallet.findOne({ sellerId: String(shop.ownerId) });
          if (!existingWallet) {
            await SellerWallet.create({
              sellerId: String(shop.ownerId),
              currency: 'ETB',
              status: 'ACTIVE',
              availableBalance: 0,
              pendingBalance: 0,
              totalEarned: 0,
              totalCommissionDeducted: 0,
              totalRefunded: 0,
              totalAdjusted: 0,
              totalPaidOut: 0,
            });
            console.log(`  ✓ Initialized wallet for seller ${shop.ownerId}`);
          }
        } catch (wErr) {
          console.warn(`  [wallet] Warning for seller ${shop.ownerId}:`, wErr.message);
        }
      }
      shops.push(shop);
    }

    // ── 4. Seed 60 Real Products with >2 Images per Product & Rich Branding ──
    console.log('\n── Seeding 60 Real Products with >2 Images & Distinct Branding ──');

    const PRODUCTS_DEF = [
      // ════════════════════════════════════════════════════════════════════════
      // Shop 0: Harar Coffee Roastery & Spices (Harar) — Brand: Harari Gold
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 0,
        sku: 'HCF-001',
        name: 'Harar Longberry Grade 1 Coffee Beans 1kg',
        category: 'Ethiopian Coffee & Spices',
        subcategory: 'Coffee Beans',
        tags: 'Harari Gold, Coffee, Arabica, Single Origin, Whole Bean, Ethiopian Coffee',
        description: 'Renowned worldwide for its bold winey flavor, fruity mocha notes, and aromatic floral profile. 100% Arabica sun-dried natural longberry beans hand-picked from the mountain terraces of Harar.',
        originalPrice: 650,
        discountPrice: 580,
        stock: 120,
        images: [
          'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1587734195503-904fca47e0e9?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1447933601403-0c6688de566e?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 0,
        sku: 'HCF-002',
        name: 'Traditional Ethiopian Spiced Berbere Blend 500g',
        category: 'Ethiopian Coffee & Spices',
        subcategory: 'Spices',
        tags: 'Jugol Spices, Berbere, Seasoning, Organic, Red Pepper, Traditional',
        description: 'Authentic stone-ground spicy blend made with sun-ripened red chili peppers, sacred korarima, fenugreek, ginger, garlic, cloves, and wild mountain herbs. The vibrant soul of Doro Wat and Ethiopian stews.',
        originalPrice: 350,
        discountPrice: 290,
        stock: 150,
        images: [
          'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1509358271058-acd22cc93898?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 0,
        sku: 'HCF-003',
        name: 'Spicy Highland Mitmita Seasoning Powder 250g',
        category: 'Ethiopian Coffee & Spices',
        subcategory: 'Spices',
        tags: 'Jugol Spices, Mitmita, Hot Spice, Kitfo Seasoning, Chili Powder',
        description: 'Fiery and aromatic orange-red seasoning crafted from piri-piri bird eye chili peppers, cardamom, cloves, and sea salt. Indispensable for Kitfo, raw beef delicacies, and roasted meats.',
        originalPrice: 220,
        discountPrice: 190,
        stock: 90,
        images: [
          'https://images.unsplash.com/photo-1532336414038-cf19250c5757?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1506368249639-73a05d6f6488?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 0,
        sku: 'HCF-004',
        name: 'Organic Whole Korarima (Ethiopian Black Cardamom) 200g',
        category: 'Ethiopian Coffee & Spices',
        subcategory: 'Spices',
        tags: 'Harari Gold, Korarima, Black Cardamom, Organic Spices, Coffee Spice',
        description: 'Hand-harvested pods of wild Ethiopian black cardamom with a smoky, herbal, and refreshing menthol aroma. Essential for traditional coffee ceremonies, clarified butter (Niter Kibbeh), and stews.',
        originalPrice: 280,
        discountPrice: 240,
        stock: 80,
        images: [
          'https://images.unsplash.com/photo-1599940824399-b87987ceb72a?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1509358271058-acd22cc93898?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1506368249639-73a05d6f6488?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 0,
        sku: 'HCF-005',
        name: 'Harar Dark Roast Ground Espresso Blend 500g',
        category: 'Ethiopian Coffee & Spices',
        subcategory: 'Ground Coffee',
        tags: 'Harari Gold, Dark Roast, Ground Coffee, Espresso, Rich Crema',
        description: 'Rich artisanal dark roast ground coffee featuring decadent dark chocolate undertones, low acidity, and thick velvety crema. Specially ground for moka pots, espresso machines, and filter brewing.',
        originalPrice: 380,
        discountPrice: 330,
        stock: 110,
        images: [
          'https://images.unsplash.com/photo-1511920170033-f8396924c348?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 0,
        sku: 'HCF-006',
        name: 'Traditional Clay Coffee Roasting Pan & Stirrer (Menkeskesha)',
        category: 'Home & Living',
        subcategory: 'Coffee Ceremony',
        tags: 'Harari Heritage, Coffee Roasting, Clay Pan, Menkeskesha, Cultural Heritage',
        description: 'Authentic handmade perforated clay roasting pan with wooden handle and traditional wire stirrer. Creates the intoxicating aroma of freshly roasted green coffee beans right in your kitchen.',
        originalPrice: 520,
        discountPrice: 450,
        stock: 45,
        images: [
          'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1615865417491-9941019fbc00?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 1: Harar Heritage Crafts & Mesob (Harar) — Brand: Jugol Artisans
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 1,
        sku: 'HHC-001',
        name: 'Authentic Harari Handwoven Mesob Basket (Large)',
        category: 'Handcrafts & Cultural Artifacts',
        subcategory: 'Mesob & Baskets',
        tags: 'Jugol Artisans, Mesob, Handwoven, Cultural Decor, Harari Basket, Heirloom',
        description: 'Iconic Ethiopian dining table basket meticulously hand-coiled with wild dried savannah grasses and vibrant naturally dyed threads in historic Harari geometric motifs. A stunning cultural masterpiece.',
        originalPrice: 3200,
        discountPrice: 2850,
        stock: 25,
        images: [
          'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1606760227091-3dd870d97f1d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1590736969955-71cc94801759?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 1,
        sku: 'HHC-002',
        name: 'Decorative Harari Wall Plate Baskets (Set of 3)',
        category: 'Handcrafts & Cultural Artifacts',
        subcategory: 'Wall Decor',
        tags: 'Jugol Artisans, Wall Decor, Basket Plates, Bohemian, Handwoven, African Art',
        description: 'Trio of handwoven wall-hanging plates crafted by master women weavers inside Harar Jugol. Features concentric sunburst and mandala designs in crimson, saffron, and natural grass hues.',
        originalPrice: 1650,
        discountPrice: 1400,
        stock: 40,
        images: [
          'https://images.unsplash.com/photo-1584589167171-541ce45f1eea?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 1,
        sku: 'HHC-003',
        name: 'Hand-Carved Ethiopian Acacia Wood Stool (Barchuma)',
        category: 'Home & Living',
        subcategory: 'Furniture',
        tags: 'Jugol Artisans, Barchuma, Wooden Stool, Hand Carved, Acacia, Traditional Living',
        description: 'Carved from a single solid block of seasoned Ethiopian acacia hardwood. Sturdy tripod legs and curved ergonomic seat polished with beeswax for a rich antique patina.',
        originalPrice: 2400,
        discountPrice: 2100,
        stock: 30,
        images: [
          'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 1,
        sku: 'HHC-004',
        name: 'Traditional Handwoven Straw Bread Basket (Agelgil)',
        category: 'Handcrafts & Cultural Artifacts',
        subcategory: 'Storage & Baskets',
        tags: 'Jugol Artisans, Agelgil, Straw Basket, Bread Box, Eco Friendly',
        description: 'Lightweight lidded bread and lunch container woven from highland straw with dyed leather reinforcement straps. Perfect for keeping Injera, breads, or snacks fresh.',
        originalPrice: 750,
        discountPrice: 650,
        stock: 55,
        images: [
          'https://images.unsplash.com/photo-1606760227091-3dd870d97f1d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1584589167171-541ce45f1eea?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1590736969955-71cc94801759?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 1,
        sku: 'HHC-005',
        name: 'Harari Cultural Tapestry & Embroidered Cushion Cover (Pair)',
        category: 'Home & Living',
        subcategory: 'Textiles',
        tags: 'Jugol Artisans, Cushion Covers, Embroidered, Harari Style, Home Decor',
        description: 'Set of two 45x45cm cushion covers featuring vibrant Harari geometric cross-stitch embroidery on heavy natural cotton canvas with hidden brass zippers.',
        originalPrice: 1100,
        discountPrice: 950,
        stock: 45,
        images: [
          'https://images.unsplash.com/photo-1540518614846-7ede433c4ef5?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 1,
        sku: 'HHC-006',
        name: 'Ethiopian History & Heritage Hardcover Book',
        category: 'Books & Cultural Heritage',
        subcategory: 'History & Culture',
        tags: 'Jugol Artisans, Ethiopian History, Harar Chronicle, Cultural Heritage, Hardcover Book',
        description: 'Comprehensive illustrated hardcover chronicle detailing eastern Ethiopian caravan routes, historic Harar Jugol architecture, UNESCO sites, and centuries of artisan craftsmanship.',
        originalPrice: 980,
        discountPrice: 850,
        stock: 60,
        images: [
          'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 2: Ras Makonnen Traditional Leatherworks (Harar) — Brand: Ras Makonnen
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 2,
        sku: 'RML-001',
        name: 'Handcrafted Ethiopian Highland Leather Messenger Bag',
        category: 'Leather Goods & Accessories',
        subcategory: 'Bags & Briefcases',
        tags: 'Ras Makonnen, Leather Bag, Messenger Bag, Highland Cowhide, Laptop Bag',
        description: 'Crafted from 100% full-grain Ethiopian highland cowhide with vegetable tanning. Accommodates up to 15-inch laptops, padded shoulder strap, solid brass buckle closures, and multiple interior organizer pockets.',
        originalPrice: 3800,
        discountPrice: 3250,
        stock: 28,
        images: [
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 2,
        sku: 'RML-002',
        name: 'Vintage Brown Leather Travel Weekender Duffel 45L',
        category: 'Leather Goods & Accessories',
        subcategory: 'Travel Bags',
        tags: 'Ras Makonnen, Duffle Bag, Travel Gear, Genuine Leather, Weekender',
        description: 'Spacious 45-liter carry-on duffel built from supple, distressed pull-up leather. Heavy-duty YKK zippers, reinforced bottom with protective metal studs, and waterproof cotton lining.',
        originalPrice: 4800,
        discountPrice: 4100,
        stock: 20,
        images: [
          'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 2,
        sku: 'RML-003',
        name: 'Full-Grain Ethiopian Cowhide Bi-Fold Wallet',
        category: 'Leather Goods & Accessories',
        subcategory: 'Wallets',
        tags: 'Ras Makonnen, Bi-fold Wallet, RFID Protected, Full Grain Leather, Mens Gift',
        description: 'Slim bi-fold wallet hand-stitched with waxed linen thread. Features 8 card slots, dual cash compartments, clear ID window, and built-in RFID blocking shield.',
        originalPrice: 850,
        discountPrice: 690,
        stock: 75,
        images: [
          'https://images.unsplash.com/photo-1627123424574-724758594e93?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 2,
        sku: 'RML-004',
        name: 'Handmade Leather Travel Backpack with Brass Hardware',
        category: 'Leather Goods & Accessories',
        subcategory: 'Backpacks',
        tags: 'Ras Makonnen, Backpack, Leather Rucksack, Daypack, Outdoor',
        description: 'Rugged yet elegant heritage leather rucksack designed for city commutes and weekend journeys. Ergonomic padded straps, drawstring closure with fold-over buckle flap, and quick-access side pockets.',
        originalPrice: 4200,
        discountPrice: 3600,
        stock: 22,
        images: [
          'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 2,
        sku: 'RML-005',
        name: 'Classic Artisan Leather Belt with Antique Brass Buckle',
        category: 'Leather Goods & Accessories',
        subcategory: 'Belts',
        tags: 'Ras Makonnen, Leather Belt, Brass Buckle, Mens Belt, Full Grain',
        description: 'Single-ply 38mm wide full-grain bridle leather belt. Hand-beveled and burnished edges, solid cast antique brass buckle, guaranteed to last decades.',
        originalPrice: 950,
        discountPrice: 790,
        stock: 65,
        images: [
          'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1627123424574-724758594e93?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 2,
        sku: 'RML-006',
        name: 'Handcrafted Ethiopian Leather Slip-on Casual Shoes',
        category: 'Traditional & Modern Fashion',
        subcategory: 'Footwear',
        tags: 'Ras Makonnen, Leather Shoes, Loafers, Mules, Handcrafted Footwear',
        description: 'Breathable unlined Ethiopian sheepskin loafers with flexible natural rubber outsoles. Extremely soft, conforming quickly to foot shape for unmatched all-day comfort.',
        originalPrice: 2800,
        discountPrice: 2400,
        stock: 35,
        images: [
          'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1533867617858-e7b97e060509?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 3: Abadir Heritage Silver & Jewelry (Harar) — Brand: Abadir Silver
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 3,
        sku: 'ASJ-001',
        name: 'Handmade Ethiopian Coptic Cross Silver Pendant Necklace',
        category: 'Jewelry & Traditional Ornaments',
        subcategory: 'Necklaces & Pendants',
        tags: 'Abadir Silver, Coptic Cross, Lalibela Cross, 925 Silver, Ethnic Necklace',
        description: 'Striking traditional Ethiopian cross pendant lost-wax cast in solid 925 sterling silver with intricate filigree details. Strung on an adjustable braided black cotton cord.',
        originalPrice: 2100,
        discountPrice: 1850,
        stock: 35,
        images: [
          'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 3,
        sku: 'ASJ-002',
        name: 'Traditional Lalibela Cross Filigree Drop Earrings',
        category: 'Jewelry & Traditional Ornaments',
        subcategory: 'Earrings',
        tags: 'Abadir Silver, Filigree Earrings, Silver Jewelry, Lalibela, Traditional Gift',
        description: 'Exquisite drop earrings showcasing openwork filigree crosses crafted by generational silversmiths in Harar. Lightweight, nickel-free, with secure sterling silver shepherd hooks.',
        originalPrice: 1450,
        discountPrice: 1250,
        stock: 45,
        images: [
          'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1611591475152-478d13b6676f?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 3,
        sku: 'ASJ-003',
        name: 'Vintage Amber and Carnelian Traditional Beaded Choker',
        category: 'Jewelry & Traditional Ornaments',
        subcategory: 'Necklaces & Pendants',
        tags: 'Abadir Silver, Amber Choker, Carnelian Beads, Ethnic Jewelry, Traditional Wedding',
        description: 'Statement tribal necklace combining warm glowing Baltic and copal amber beads, natural orange carnelian stones, and hand-beaten Ethiopian silver spacers.',
        originalPrice: 3400,
        discountPrice: 2950,
        stock: 18,
        images: [
          'https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 3,
        sku: 'ASJ-004',
        name: 'Handcrafted Ethiopian Silver Cuff Bangle Bracelet',
        category: 'Jewelry & Traditional Ornaments',
        subcategory: 'Bracelets & Bangles',
        tags: 'Abadir Silver, Silver Cuff, Bangle, Engraved Bangle, Handmade Bracelet',
        description: 'Solid sterling silver open cuff bracelet engraved with geometric sun patterns and cross motifs. Slightly adjustable to comfortably fit any wrist size.',
        originalPrice: 1950,
        discountPrice: 1700,
        stock: 30,
        images: [
          'https://images.unsplash.com/photo-1611591475152-478d13b6676f?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 3,
        sku: 'ASJ-005',
        name: 'Traditional Habesha Wedding Silver Headdress & Hair Pin',
        category: 'Jewelry & Traditional Ornaments',
        subcategory: 'Hair Jewelry',
        tags: 'Abadir Silver, Headdress, Habesha Wedding, Silver Hair Pin, Bridal Jewelry',
        description: 'Traditional ornate bridal hair ornament with delicate dangling silver bells and filigree disks that chime softly during wedding dances and celebrations.',
        originalPrice: 2800,
        discountPrice: 2450,
        stock: 15,
        images: [
          'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 3,
        sku: 'ASJ-006',
        name: 'Artisanal Brass & Silver Ring with Natural Green Agate',
        category: 'Jewelry & Traditional Ornaments',
        subcategory: 'Rings',
        tags: 'Abadir Silver, Agate Ring, Silver Ring, Solitaire, Vintage Style',
        description: 'Substantial mixed metal statement ring showcasing a bezel-set polished natural green Ethiopian agate stone with engraved feather etchings on the silver shank.',
        originalPrice: 1200,
        discountPrice: 990,
        stock: 40,
        images: [
          'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1611591475152-478d13b6676f?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 4: Dire Dawa Oasis Farm Fresh (Dire Dawa) — Brand: Oasis Fresh
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 4,
        sku: 'DOF-001',
        name: 'Fresh Eastern Oasis Sweet Papaya Crate (4kg)',
        category: 'Fresh Fruits & Vegetables',
        subcategory: 'Fruits',
        tags: 'Oasis Fresh, Sweet Papaya, Tropical Fruit, Dire Dawa Harvest, Farm Fresh',
        description: 'Locally grown in the warm oasis orchards of Dire Dawa. Intensely sweet, golden-orange flesh packed with natural enzymes, vitamins A and C. Hand-selected at peak ripeness.',
        originalPrice: 280,
        discountPrice: 240,
        stock: 70,
        images: [
          'https://images.unsplash.com/photo-1550258987-190a2d41a8ba?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 4,
        sku: 'DOF-002',
        name: 'Ripe Dire Dawa Tropical Mangoes (3kg Box)',
        category: 'Fresh Fruits & Vegetables',
        subcategory: 'Fruits',
        tags: 'Oasis Fresh, Mangoes, Tropical Fruit, Fresh Crate, Dire Dawa Special',
        description: 'Juicy, fiberless sun-ripened Keitt and Apple mangoes harvested from century-old irrigated groves along Dechatu stream. Deliciously fragrant and refreshing.',
        originalPrice: 320,
        discountPrice: 270,
        stock: 65,
        images: [
          'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1550258987-190a2d41a8ba?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 4,
        sku: 'DOF-003',
        name: 'Pure Raw Forest Honey from Awash Escarpment (1kg Jar)',
        category: 'Fresh Fruits & Vegetables',
        subcategory: 'Honey & Preserves',
        tags: 'Oasis Fresh, Raw Honey, Forest Honey, Pure Organic, Awash Valley',
        description: 'Unprocessed, unfiltered multi-floral amber honey collected by traditional beekeepers in the acacia woodlands of Awash. Contains active enzymes, natural pollen, and delicate floral notes.',
        originalPrice: 680,
        discountPrice: 590,
        stock: 85,
        images: [
          'https://images.unsplash.com/photo-1587049352846-4a222e784d38?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1471193945509-9ad0617afabf?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 4,
        sku: 'DOF-004',
        name: 'Fresh Ethiopian Hass Avocados (3kg Pack)',
        category: 'Fresh Fruits & Vegetables',
        subcategory: 'Vegetables & Produce',
        tags: 'Oasis Fresh, Hass Avocado, Creamy Avocado, Organic Produce',
        description: 'Creamy, rich Hass avocados grown in the mineral-rich soils of eastern Ethiopia. Perfectly smooth texture ideal for guacamole, salads, and traditional avocado smoothies (Spis).',
        originalPrice: 340,
        discountPrice: 290,
        stock: 60,
        images: [
          'https://images.unsplash.com/photo-1618897996318-5a901fa6ca71?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 4,
        sku: 'DOF-005',
        name: 'Organic Virgin Cold-Pressed Sesame Oil 500ml',
        category: 'Fresh Fruits & Vegetables',
        subcategory: 'Oils & Condiments',
        tags: 'Oasis Fresh, Sesame Oil, Cold Pressed, Cooking Oil, Pure Organic',
        description: 'First cold-pressed virgin oil extracted from locally cultivated Humera sesame seeds. Rich nutty taste with high smoke point, loaded with natural antioxidants and healthy fats.',
        originalPrice: 450,
        discountPrice: 380,
        stock: 50,
        images: [
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1608248597359-58a4369e0004?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 4,
        sku: 'DOF-006',
        name: 'Dire Dawa Sun-Dried Black Raisins & Dates 500g',
        category: 'Fresh Fruits & Vegetables',
        subcategory: 'Dried Fruits',
        tags: 'Oasis Fresh, Dried Raisins, Dates, Healthy Snacks, Eastern Ethiopia',
        description: 'Sweet, chewy natural sun-dried seedless black raisins combined with succulent oasis dates. No sulfur or added sugar; naturally packed with iron and potassium.',
        originalPrice: 310,
        discountPrice: 260,
        stock: 90,
        images: [
          'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1587049352846-4a222e784d38?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1488459716781-31db52582fe9?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 5: Dire Dawa Smart Tech Electronics (Dire Dawa) — Brand: Aritii Tech
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 5,
        sku: 'DTE-001',
        name: 'UltraSlim Pro 14" Laptop Intel i7 16GB 512GB SSD',
        category: 'Electronics & Gadgets',
        subcategory: 'Laptops & Computers',
        tags: 'Aritii Tech, Laptop, Intel Core i7, Ultrabook, FHD Display, Windows 11',
        description: 'Sleek aluminum chassis notebook powered by 12th Gen Intel Core i7 processor, 16GB DDR5 RAM, 512GB NVMe SSD, backlit keyboard, and full-day 10-hour battery life.',
        originalPrice: 58000,
        discountPrice: 52000,
        stock: 15,
        images: [
          'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1511707171634-5f897ff02560?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 5,
        sku: 'DTE-002',
        name: 'Aritii Wireless ANC Active Noise Cancelling Headphones',
        category: 'Electronics & Gadgets',
        subcategory: 'Audio',
        tags: 'Aritii Tech, ANC Headphones, Bluetooth 5.3, Noise Cancelling, Hi-Fi Audio',
        description: 'Premium over-ear headphones with hybrid active noise cancellation up to 40dB, 40mm dynamic drivers for crisp bass, transparency mode, and 50 hours of wireless playback.',
        originalPrice: 4500,
        discountPrice: 3800,
        stock: 40,
        images: [
          'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 5,
        sku: 'DTE-003',
        name: 'Titan 65W GaN Fast Charger & Braided Type-C Cable',
        category: 'Electronics & Gadgets',
        subcategory: 'Chargers & Power',
        tags: 'Aritii Tech, GaN Charger, 65W Fast Charge, USB-C, Laptop Charger',
        description: 'Next-generation Gallium Nitride (GaN) wall adapter with dual Type-C and USB-A ports. Powers smartphones, tablets, and laptops up to 65W safely with intelligent thermal protection.',
        originalPrice: 1250,
        discountPrice: 990,
        stock: 90,
        images: [
          'https://images.unsplash.com/photo-1585338107529-13afc5f02586?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1511707171634-5f897ff02560?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 5,
        sku: 'DTE-004',
        name: 'Smart Fitness Watch with Heart Rate & GPS Track',
        category: 'Electronics & Gadgets',
        subcategory: 'Smart Wearables',
        tags: 'Aritii Tech, Smart Watch, Fitness Tracker, AMOLED Display, Heart Rate',
        description: 'Water-resistant smartwatch featuring vivid 1.43" AMOLED touch screen, 120 sports modes, continuous heart rate and SpO2 tracking, sleep monitor, and 14-day battery reserve.',
        originalPrice: 3800,
        discountPrice: 3200,
        stock: 50,
        images: [
          'https://images.unsplash.com/photo-1546868871-7041f2a55e12?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1511707171634-5f897ff02560?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 5,
        sku: 'DTE-005',
        name: '20000mAh Dual USB-C Fast Power Bank with LED Display',
        category: 'Electronics & Gadgets',
        subcategory: 'Chargers & Power',
        tags: 'Aritii Tech, Power Bank, 20000mAh, Portable Battery, Fast Charge',
        description: 'High-density lithium polymer portable battery pack with 22.5W quick charge output. Digital percentage battery display, twin USB-C ports, and travel airline compliant.',
        originalPrice: 1950,
        discountPrice: 1650,
        stock: 80,
        images: [
          'https://images.unsplash.com/photo-1585338107529-13afc5f02586?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1511707171634-5f897ff02560?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 5,
        sku: 'DTE-006',
        name: 'True Wireless Stereo Earbuds with Low Latency Audio',
        category: 'Electronics & Gadgets',
        subcategory: 'Audio',
        tags: 'Aritii Tech, TWS Earbuds, Bluetooth 5.3, In-Ear, Low Latency',
        description: 'Featherlight ergonomic wireless earbuds with ENC environmental noise cancellation for crystal-clear phone calls, IPX5 sweat resistance, and compact pocket charging case.',
        originalPrice: 1800,
        discountPrice: 1450,
        stock: 75,
        images: [
          'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 6: Sabian Modern & Cultural Fashion (Dire Dawa) — Brand: Sabian
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 6,
        sku: 'SCF-001',
        name: 'Handwoven Habesha Kemis with Gold Tibeb Embroidery',
        category: 'Traditional & Modern Fashion',
        subcategory: 'Traditional Dresses',
        tags: 'Sabian Couture, Habesha Kemis, Tibeb, Shemma Cotton, Ethiopian Dress, Bridal',
        description: 'Exquisite full-length traditional dress handspun from pure Ethiopian cotton (Shemma), accented with radiant golden Tibeb embroidery borders along the neckline, cuffs, and hem. Includes matching Netela shawl.',
        originalPrice: 4200,
        discountPrice: 3500,
        stock: 30,
        images: [
          'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1539109136881-3be0616acf4b?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 6,
        sku: 'SCF-002',
        name: 'Premium Shemane Handwoven Cotton Gabi Blanket',
        category: 'Traditional & Modern Fashion',
        subcategory: 'Traditional Blankets',
        tags: 'Sabian Couture, Gabi, Shemane, 4 Layer Cotton, Ethiopian Shawl, Warm Blanket',
        description: 'Luxurious four-layer handwoven Ethiopian cotton blanket crafted on traditional pit looms. Features distinctive colorful geometric border weaves. Soft, insulating, and deeply comforting.',
        originalPrice: 1850,
        discountPrice: 1550,
        stock: 45,
        images: [
          'https://images.unsplash.com/photo-1520903920243-00d872a2d1c9?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1607345366928-199ea26cfe3e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 6,
        sku: 'SCF-003',
        name: 'Handwoven Netela Scarf with Traditional Border Pattern',
        category: 'Traditional & Modern Fashion',
        subcategory: 'Scarves & Shawls',
        tags: 'Sabian Couture, Netela, Scarf, Handwoven Cotton, Ethiopian Scarf',
        description: 'Feather-light two-layer white cotton scarf bordered by intricate woven multicolored thread patterns. Can be draped elegantly over shoulders for holidays, church, or daily wear.',
        originalPrice: 650,
        discountPrice: 520,
        stock: 80,
        images: [
          'https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 6,
        sku: 'SCF-004',
        name: 'Modern Men\'s Embroidered Linen Kurta Shirt',
        category: 'Traditional & Modern Fashion',
        subcategory: 'Men\'s Clothing',
        tags: 'Sabian Couture, Mens Shirt, Linen Shirt, Embroidered Collar, Modern Habesha',
        description: 'Contemporary mandarin collar tunic shirt tailored from premium breathable natural linen. Detailed with discreet tonal Ethiopian embroidery along the placket and cuffs.',
        originalPrice: 1400,
        discountPrice: 1150,
        stock: 55,
        images: [
          'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1520903920243-00d872a2d1c9?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1607345366928-199ea26cfe3e?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 6,
        sku: 'SCF-005',
        name: 'Contemporary Ethiopian Cotton Casual Maxi Dress',
        category: 'Traditional & Modern Fashion',
        subcategory: 'Women\'s Dresses',
        tags: 'Sabian Couture, Maxi Dress, Casual Dress, Cotton Dress, Modern Style',
        description: 'Effortless bohemian maxi dress cut from breathable hand-spun raw cotton with side pockets, flattering tiered silhouette, and subtle gold thread embroidery details.',
        originalPrice: 2200,
        discountPrice: 1850,
        stock: 40,
        images: [
          'https://images.unsplash.com/photo-1509631179647-0177331693ae?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1539109136881-3be0616acf4b?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 6,
        sku: 'SCF-006',
        name: 'Handcrafted Dire Dawa Leather Loafers',
        category: 'Leather Goods & Accessories',
        subcategory: 'Footwear',
        tags: 'Sabian Couture, Loafers, Leather Shoes, Mens Casual, Calfskin',
        description: 'Locally tanned Ethiopian highland calfskin slip-on shoes with durable vulcanized soles and cushioned arch support for daily city walking.',
        originalPrice: 3200,
        discountPrice: 2750,
        stock: 35,
        images: [
          'https://images.unsplash.com/photo-1533867617858-e7b97e060509?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 7: Awash Valley Spices & Grain Trading (Dire Dawa) — Brand: Awash
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 7,
        sku: 'ASG-001',
        name: 'Premium Magna White Teff Grain 5kg (Gluten Free)',
        category: 'Grains & Pantry Staples',
        subcategory: 'Teff & Flour',
        tags: 'Awash Valley, Magna Teff, White Teff, Gluten Free, Injera Grain, Superfood',
        description: 'Highest-grade Magna ivory white teff seed sourced directly from sustainable highland growers. Superfood ancient grain loaded with calcium, iron, protein, and amino acids. Ideal for baking authentic Injera.',
        originalPrice: 950,
        discountPrice: 820,
        stock: 160,
        images: [
          'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515543237350-b3eea1ec8082?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 7,
        sku: 'ASG-002',
        name: 'Pure Black Cumin Seeds (Tikur Azmud / Habasoda) 500g',
        category: 'Grains & Pantry Staples',
        subcategory: 'Seeds & Spices',
        tags: 'Awash Valley, Black Cumin, Tikur Azmud, Nigella Sativa, Herbal Health',
        description: 'Aromatic Ethiopian Nigella Sativa (black cumin) seeds. Famous in traditional herbal wellness and used to top homemade breads, flatbreads, and aromatic culinary dishes.',
        originalPrice: 320,
        discountPrice: 260,
        stock: 120,
        images: [
          'https://images.unsplash.com/photo-1508736793122-f516e3ba5569?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1599940824399-b87987ceb72a?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1509358271058-acd22cc93898?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 7,
        sku: 'ASG-003',
        name: 'Organic Split Red Lentils (Yemisir Kik) 2kg',
        category: 'Grains & Pantry Staples',
        subcategory: 'Pulses & Legumes',
        tags: 'Awash Valley, Red Lentils, Yemisir Kik, Misir Wat, Plant Protein',
        description: 'Triple-cleaned split red lentils harvested from fertile volcanic soils. Cook quickly to a velvety texture for authentic Misir Wat, vegan lentil soups, and high-protein stews.',
        originalPrice: 420,
        discountPrice: 360,
        stock: 140,
        images: [
          'https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515543237350-b3eea1ec8082?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 7,
        sku: 'ASG-004',
        name: 'Traditional Fenugreek Seeds (Abish Powder) 400g',
        category: 'Grains & Pantry Staples',
        subcategory: 'Seeds & Spices',
        tags: 'Awash Valley, Fenugreek, Abish, Digestive Spice, Traditional Herb',
        description: 'Finely milled golden fenugreek seed powder. Used extensively in Ethiopian cuisine to aid digestion, enrich bread doughs, and prepare nutritious traditional morning porridge.',
        originalPrice: 240,
        discountPrice: 195,
        stock: 95,
        images: [
          'https://images.unsplash.com/photo-1509358271058-acd22cc93898?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1508736793122-f516e3ba5569?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1599940824399-b87987ceb72a?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 7,
        sku: 'ASG-005',
        name: 'Whole Dried Rosemary & Thyme Herbal Blend 250g',
        category: 'Ethiopian Coffee & Spices',
        subcategory: 'Herbs & Seasonings',
        tags: 'Awash Valley, Rosemary, Thyme, Tosign, Roasted Meat Herbs',
        description: 'Wild mountain Tosign (Ethiopian wild thyme) and fragrant sun-dried rosemary needles. Excellent for roasting lamb (Tibs), marinating poultry, or brewing herbal wellness tea.',
        originalPrice: 190,
        discountPrice: 160,
        stock: 110,
        images: [
          'https://images.unsplash.com/photo-1599940824399-b87987ceb72a?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1506368249639-73a05d6f6488?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1509358271058-acd22cc93898?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 7,
        sku: 'ASG-006',
        name: 'Organic Brown Teff Grain 5kg (High Iron & Fiber)',
        category: 'Grains & Pantry Staples',
        subcategory: 'Teff & Flour',
        tags: 'Awash Valley, Brown Teff, Tikur Teff, Ancient Grain, High Iron',
        description: 'Nutty, earthy brown teff grains boasting superior iron, dietary fiber, and mineral content. Produces dark, tangy Injera with traditional depth and complexity.',
        originalPrice: 880,
        discountPrice: 760,
        stock: 130,
        images: [
          'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1515543237350-b3eea1ec8082?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 8: Sheger Home Living & Artisanal Decor (Kazira / Addis) — Brand: Sheger
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 8,
        sku: 'SHL-001',
        name: 'Traditional Hand-Polished Wooden Rekebot Coffee Tray Set',
        category: 'Home & Living',
        subcategory: 'Coffee Ceremony',
        tags: 'Sheger Living, Rekebot, Coffee Table, Wood Inlay, Coffee Ceremony, Handcrafted',
        description: 'Exquisite wooden Rekebot coffee tray cabinet fitted with decorative brass corners and pull-out storage drawer for incense and cups. The centerpiece of every Ethiopian home.',
        originalPrice: 4500,
        discountPrice: 3850,
        stock: 20,
        images: [
          'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 8,
        sku: 'SHL-002',
        name: 'Authentic Black Clay Jebena Coffee Pot (Handmade)',
        category: 'Home & Living',
        subcategory: 'Coffee Ceremony',
        tags: 'Sheger Living, Jebena, Clay Pot, Ethiopian Coffee Maker, Black Clay',
        description: 'Traditional round-bottom black clay coffee kettle handmade by master potters. Features spherical base, long pouring spout, and straw stand for serving authentic boiled Bunna.',
        originalPrice: 850,
        discountPrice: 720,
        stock: 50,
        images: [
          'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1615865417491-9941019fbc00?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 8,
        sku: 'SHL-003',
        name: 'Terracotta Incense Burner (Mabkheya) with Frankincense Resin',
        category: 'Home & Living',
        subcategory: 'Incense & Fragrance',
        tags: 'Sheger Living, Mabkheya, Incense Burner, Frankincense, Terracotta, Aromatherapy',
        description: 'Clay incense burner accompanied by 150g of natural Tigray frankincense resin. Fills living spaces with purifying, meditative woody-citrus aromatic smoke.',
        originalPrice: 620,
        discountPrice: 490,
        stock: 65,
        images: [
          'https://images.unsplash.com/photo-1615865417491-9941019fbc00?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1571781926291-c477ebfd024b?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 8,
        sku: 'SHL-004',
        name: 'Set of 6 Traditional Cini Ceramic Espresso Cups',
        category: 'Home & Living',
        subcategory: 'Tableware',
        tags: 'Sheger Living, Cini Cups, Ceramic Cups, Coffee Cups, Ethiopian Dinnerware',
        description: 'Six delicate ceramic handle-less cups with saucers adorned with traditional Ethiopian red, green, and gold ribbon motifs. Microwave and dishwasher safe.',
        originalPrice: 780,
        discountPrice: 650,
        stock: 70,
        images: [
          'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1511920170033-f8396924c348?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 8,
        sku: 'SHL-005',
        name: 'Handmade Natural Wool Ethiopian Pattern Throw Blanket',
        category: 'Home & Living',
        subcategory: 'Textiles',
        tags: 'Sheger Living, Wool Blanket, Throw Blanket, Handwoven, Cozy Living',
        description: 'Generously sized 150x200cm cozy throw blanket hand-spun from pure highland sheep wool. Features minimalist geometric motifs that complement any modern interior.',
        originalPrice: 2600,
        discountPrice: 2200,
        stock: 35,
        images: [
          'https://images.unsplash.com/photo-1540518614846-7ede433c4ef5?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 8,
        sku: 'SHL-006',
        name: 'Handcrafted Wooden Spoon and Utensil Serving Set',
        category: 'Home & Living',
        subcategory: 'Kitchen Utensils',
        tags: 'Sheger Living, Wooden Spoons, Kitchen Set, Olive Wood, Cooking Utensils',
        description: 'Set of 4 artisan kitchen spoons hand-carved from dense Ethiopian wild olive wood. Naturally moisture resistant, gentle on non-stick cookware, with stunning grain marbling.',
        originalPrice: 650,
        discountPrice: 520,
        stock: 60,
        images: [
          'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
        ],
      },

      // ════════════════════════════════════════════════════════════════════════
      // Shop 9: Highland Pure Organics & Herbal Care (Dire Dawa) — Brand: Highland
      // ════════════════════════════════════════════════════════════════════════
      {
        shopIndex: 9,
        sku: 'HPO-001',
        name: 'Pure Ethiopian Cold-Pressed Black Castor Oil 250ml',
        category: 'Beauty & Personal Care',
        subcategory: 'Hair & Scalp Care',
        tags: 'Highland Organics, Castor Oil, Cold Pressed, Hair Growth, Scalp Treatment',
        description: 'Authentic pure castor oil expeller-pressed from organically grown Ethiopian castor beans. High ricinoleic acid content strengthens hair roots, thickens eyebrows, and deeply hydrates dry scalps.',
        originalPrice: 420,
        discountPrice: 350,
        stock: 120,
        images: [
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1608248597359-58a4369e0004?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 9,
        sku: 'HPO-002',
        name: 'Natural Qasil Leaf Cleansing Face & Hair Powder 200g',
        category: 'Beauty & Personal Care',
        subcategory: 'Skincare',
        tags: 'Highland Organics, Qasil Powder, Cleansing Mask, Natural Skincare, Organic Detox',
        description: 'Finely ground leaves of wild Gob tree (Ziziphus Mauritiana). When mixed with warm water, it creates a gentle natural soapy lather that detoxifies pores, calms acne, and cleanses scalp.',
        originalPrice: 350,
        discountPrice: 290,
        stock: 100,
        images: [
          'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1601049541289-9b1b7bbbfe19?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 9,
        sku: 'HPO-003',
        name: 'Organic Beeswax & Shea Butter Moisturizing Lip Balm (3-Pack)',
        category: 'Beauty & Personal Care',
        subcategory: 'Lip Care',
        tags: 'Highland Organics, Lip Balm, Natural Beeswax, Shea Butter, Organic Cosmetics',
        description: 'Trio of nourishing lip balms crafted from unbleached Ethiopian wild forest beeswax, unrefined shea butter, and sweet orange essential oils. Protects against chapping in dry climates.',
        originalPrice: 280,
        discountPrice: 220,
        stock: 110,
        images: [
          'https://images.unsplash.com/photo-1601049541289-9b1b7bbbfe19?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1608248597359-58a4369e0004?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 9,
        sku: 'HPO-004',
        name: 'Highland Frankincense & Myrrh Night Recovery Balm 100g',
        category: 'Beauty & Personal Care',
        subcategory: 'Skincare',
        tags: 'Highland Organics, Frankincense Balm, Anti Aging, Night Cream, Myrrh Extract',
        description: 'Concentrated restorative face and body balm infused with steam-distilled Boswellia Carterii (frankincense) and Commiphora (myrrh) extracts. Reduces fine lines and improves skin elasticity overnight.',
        originalPrice: 650,
        discountPrice: 540,
        stock: 75,
        images: [
          'https://images.unsplash.com/photo-1571781926291-c477ebfd024b?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1608248597359-58a4369e0004?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 9,
        sku: 'HPO-005',
        name: 'Cold-Pressed Moringa Seed Face Glow Oil 60ml',
        category: 'Beauty & Personal Care',
        subcategory: 'Face Oils',
        tags: 'Highland Organics, Moringa Oil, Face Oil, Glowing Skin, Vitamin E Oil',
        description: 'Lightweight, rapid-absorbing nutrient-dense dry oil pressed from Ethiopian Moringa Stenopetala seeds. Rich in oleic acid and vitamins E and C for radiant, non-greasy all-day moisture.',
        originalPrice: 480,
        discountPrice: 390,
        stock: 85,
        images: [
          'https://images.unsplash.com/photo-1608248597359-58a4369e0004?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
        ],
      },
      {
        shopIndex: 9,
        sku: 'HPO-006',
        name: 'Traditional Eucalyptus & Peppermint Herbal Inhalation Salve',
        category: 'Beauty & Personal Care',
        subcategory: 'Herbal Wellness',
        tags: 'Highland Organics, Herbal Salve, Eucalyptus, Respiratory Care, Natural Balm',
        description: 'Aromatic therapeutic chest rub blending natural Ethiopian blue gum eucalyptus oil, wild peppermint, and camphor in a soothing beeswax base. Opens airways and relieves congestion.',
        originalPrice: 240,
        discountPrice: 190,
        stock: 95,
        images: [
          'https://images.unsplash.com/photo-1601049541289-9b1b7bbbfe19?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
        ],
      },
    ];

    const seededProducts = [];
    for (const prodDef of PRODUCTS_DEF) {
      const shop = shops[prodDef.shopIndex];
      const categoryId = categoryMap.get(prodDef.category) || null;

      const productPayload = {
        name: prodDef.name,
        sku: prodDef.sku,
        description: prodDef.description,
        category: prodDef.category,
        subcategory: prodDef.subcategory || '',
        tags: prodDef.tags || '',
        categoryId,
        originalPrice: prodDef.originalPrice,
        discountPrice: prodDef.discountPrice,
        stock: prodDef.stock,
        reserved: 0,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        isActive: true,
        currency: 'ETB',
        images: prodDef.images,
        shopId: shop._id.toString(),
        shop: {
          _id: shop._id,
          name: shop.name,
          email: shop.email,
          ownerId: shop.ownerId,
          address: shop.address,
          phoneNumber: shop.phoneNumber,
          role: 'Seller',
          zipCode: shop.zipCode,
          availableBalance: 0,
          transections: [],
          avatar: shop.avatar,
          createdAt: shop.createdAt,
        },
        sellerId: shop.ownerId,
        sold_out: Math.floor(Math.random() * 35) + 8,
        ratings: Number((Math.random() * 0.7 + 4.3).toFixed(1)),
      };

      let product = await Product.findOne({ sku: prodDef.sku });
      if (!product) {
        product = await Product.findOne({ name: prodDef.name });
      }

      if (product) {
        await Product.updateOne({ _id: product._id }, { $set: productPayload });
        product = await Product.findById(product._id);
        console.log(`  ✓ Updated product: ${product.name} (${product.sku})`);
      } else {
        product = await Product.create(productPayload);
        console.log(`  + Created product: ${product.name} (${product.sku})`);
      }
      seededProducts.push(product);
    }

    // ── 5. Seed Compatible Orders with Location Validation ───────────────────
    console.log('\n── Seeding Location-Validated Orders ──');

    const buyer1Id = await getSellerUserId('buyer1@aritii.com', 'buyer1-id');
    const buyer2Id = await getSellerUserId('buyer2@aritii.com', 'buyer2-id');

    const demoOrders = [
      // Order 1: Delivered local order in Harar
      {
        orderNumber: 'ORD-HAR-001',
        buyerId: buyer1Id,
        buyerName: 'Amina Kedir',
        buyerEmail: 'buyer1@aritii.com',
        buyerPhone: '+251911440001',
        shop: shops[0], // Harar Coffee Roastery
        product: seededProducts[0], // Harar Coffee Beans
        quantity: 2,
        status: ORDER_STATUSES.DELIVERED,
        fulfilmentType: 'delivery',
        shippingAddress: {
          address1: 'Near Jugol Gate, House 42',
          city: 'Harar',
          country: 'Ethiopia',
        },
        destination: {
          locationId: locJugol._id.toString(),
          locationCode: 'HAR-JUG',
          locationName: 'Jugol (Historic Walled City)',
          regionId: locHararghe._id.toString(),
          regionName: 'Hararghe',
          cityId: locHararCity._id.toString(),
          cityName: 'Harar',
          deliveryZoneId: zoneHararCity._id.toString(),
          deliveryZoneName: 'Harar City Zone',
          contactPhone: '+251911440001',
          contactName: 'Amina Kedir',
        },
        deliveryFee: 50,
      },
      // Order 2: Processing local order in Dire Dawa
      {
        orderNumber: 'ORD-DD-002',
        buyerId: buyer2Id,
        buyerName: 'Dawit Alemu',
        buyerEmail: 'buyer2@aritii.com',
        buyerPhone: '+251911440002',
        shop: shops[4], // Dire Dawa Oasis Farm Fresh
        product: seededProducts[26], // Honey
        quantity: 1,
        status: ORDER_STATUSES.PROCESSING,
        fulfilmentType: 'delivery',
        shippingAddress: {
          address1: 'Kazira Commercial Street, Building 15',
          city: 'Dire Dawa City',
          country: 'Ethiopia',
        },
        destination: {
          locationId: locKazira._id.toString(),
          locationCode: 'DD-KAZ',
          locationName: 'Kazira',
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          deliveryZoneId: zoneDdCity._id.toString(),
          deliveryZoneName: 'Dire Dawa Zone',
          contactPhone: '+251911440002',
          contactName: 'Dawit Alemu',
        },
        deliveryFee: 55,
      },
      // Order 3: Intercity order from Harar leather shop to Dire Dawa buyer
      {
        orderNumber: 'ORD-INTER-003',
        buyerId: buyer2Id,
        buyerName: 'Dawit Alemu',
        buyerEmail: 'buyer2@aritii.com',
        buyerPhone: '+251911440002',
        shop: shops[2], // Ras Makonnen Leather (Harar)
        product: seededProducts[12], // Messenger Bag
        quantity: 1,
        status: ORDER_STATUSES.SHIPPED,
        fulfilmentType: 'delivery',
        shippingAddress: {
          address1: 'Kazira Commercial Street, Building 15',
          city: 'Dire Dawa City',
          country: 'Ethiopia',
        },
        destination: {
          locationId: locKazira._id.toString(),
          locationCode: 'DD-KAZ',
          locationName: 'Kazira',
          regionId: locDireDawaRegion._id.toString(),
          regionName: 'Dire Dawa',
          cityId: locDdCity._id.toString(),
          cityName: 'Dire Dawa City',
          deliveryZoneId: zoneIntercity._id.toString(),
          deliveryZoneName: 'Harar - Dire Dawa Intercity Zone',
          contactPhone: '+251911440002',
          contactName: 'Dawit Alemu',
        },
        deliveryFee: 180,
      },
    ];

    for (const o of demoOrders) {
      const existing = await Order.findOne({ orderNumber: o.orderNumber });
      const itemSubtotal = o.product.discountPrice * o.quantity;
      const totalAmount = itemSubtotal + o.deliveryFee;

      const orderPayload = {
        orderNumber: o.orderNumber,
        buyerId: o.buyerId,
        user: {
          _id: o.buyerId,
          id: o.buyerId,
          name: o.buyerName,
          email: o.buyerEmail,
          phoneNumber: o.buyerPhone,
        },
        cart: [
          {
            _id: o.product._id,
            productId: o.product._id,
            name: o.product.name,
            price: o.product.discountPrice,
            quantity: o.quantity,
            shopId: o.shop._id.toString(),
            images: o.product.images,
          },
        ],
        shippingAddress: o.shippingAddress,
        destination: o.destination,
        totalPrice: totalAmount,
        subTotalPrice: itemSubtotal,
        shipping: o.deliveryFee,
        discountAmount: 0,
        status: o.status,
        fulfilmentType: o.fulfilmentType,
        sellerShipments: [
          {
            sellerId: o.shop.ownerId,
            shopId: o.shop._id.toString(),
            status: o.status,
            subtotal: itemSubtotal,
            shippingFee: o.deliveryFee,
            total: totalAmount,
          },
        ],
        paymentInfo: {
          id: `pay-${o.orderNumber.toLowerCase()}`,
          status: 'SUCCESS',
          type: 'Cash on Delivery',
        },
        createdAt: new Date(Date.now() - Math.floor(Math.random() * 86400000 * 5)),
        deliveredAt: o.status === ORDER_STATUSES.DELIVERED ? new Date() : null,
      };

      let orderDoc;
      if (existing) {
        await Order.updateOne({ _id: existing._id }, { $set: orderPayload });
        orderDoc = await Order.findById(existing._id);
        console.log(`  ✓ Updated demo order ${o.orderNumber}`);
      } else {
        orderDoc = await Order.create(orderPayload);
        console.log(`  + Created demo order ${o.orderNumber}`);
      }

      // Link order delivery bridge
      try {
        await orderDeliveryService.linkForOrder(orderDoc, orderDoc.sellerShipments?.[0], orderDoc.destination);
      } catch (bridgeErr) {
        // Safe to ignore in stand-alone run
      }
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('COMMERCE SEED COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Categories: ${await Category.countDocuments()} total`);
    console.log(`  Shops:      ${await Shop.countDocuments()} total`);
    console.log(`  Products:   ${await Product.countDocuments()} total`);
    console.log(`  Orders:     ${await Order.countDocuments()} total`);
    console.log('='.repeat(60));

    return {
      categories: await Category.countDocuments(),
      shops: await Shop.countDocuments(),
      products: await Product.countDocuments(),
      orders: await Order.countDocuments(),
    };
  } catch (error) {
    console.error('Commerce seed failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { seed, CATEGORIES };

if (require.main === module) {
  const isReset = process.argv.includes('--reset');
  seed({ reset: isReset }).then(() => process.exit(0));
}
