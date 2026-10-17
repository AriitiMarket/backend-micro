/**
 * Hierarchy tests — User -> Seller Actor -> Business -> Shop -> Products/Orders/Inventory.
 *
 * Node's built-in runner (`node --test`) against a dedicated test database.
 * Identity/Delivery clients are stubbed so the suite never depends on another
 * service being up, but the REAL service code runs, so a broken link between
 * two layers fails here.
 *
 * What is covered:
 *   * Shop -> Business (linking, auto-provisioning, reuse, idempotency)
 *   * Order -> Business (a shipment carries a business id, never a user id)
 *   * Product -> Shop ownership (permission isolation between sellers)
 *   * Admin business scoping (businessId resolves to shops, and only those)
 *   * Editing/approving a provisioned business record
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, beforeEach, after, afterEach } = require('node:test');

const DB_URL = process.env.MONGODB_URI_TEST
  || 'mongodb://localhost:27017/ariti_commerce_test_hierarchy';
process.env.MONGODB_URI = DB_URL;

const SECTOR_ID = '64b0000000000000000000b2';
const CITY_ID = '64b0000000000000000000a1';

const COLLECTIONS = [
  'shops', 'sellerapplications', 'products', 'orders', 'orderdeliveries', 'stockmovements',
];

let Shop;
let SellerApplication;
let Product;
let Order;
let shopService;
let sellerAppService;
let productsService;
let orderService;
let shopRepository;
let sellerAppRepository;
let businessService;
let resolveHierarchyScope;
let identityClient;
let deliveryClient;

function shopDoc(overrides = {}) {
  return {
    name: 'Hierarchy Shop', email: 'hier@shop.local', address: '1 Test Street',
    phoneNumber: '911000000', zipCode: '1000', ownerId: 'seller-a', status: 'APPROVED',
    avatar: { public_id: 'a', url: '/uploads/a.png' },
    showOnPublic: true,
    locationSnapshot: {
      regionId: '64b0000000000000000000a9', regionName: 'Hararghe',
      areaId: null, areaName: '',
      cityId: CITY_ID, cityName: 'Harar',
      sectorId: SECTOR_ID, sectorName: 'Sector 01',
      fullAddress: '1 Test Street', landmark: '', building: '',
      contactPhone: '911000000',
      coordinates: { latitude: null, longitude: null },
      resolvedAt: new Date(),
    },
    ...overrides,
  };
}

async function createShopDoc(overrides = {}) {
  return Shop.create(shopDoc(overrides));
}

async function createBusiness(ownerId, overrides = {}) {
  return SellerApplication.create({
    ownerId,
    userId: ownerId,
    sellerType: 'BUSINESS',
    businessInformation: { businessName: `Business of ${ownerId}`, email: `${ownerId}@b.local` },
    status: 'APPROVED',
    ...overrides,
  });
}

function productDoc(shop, overrides = {}) {
  return {
    name: 'Hierarchy Product', description: 'p', category: 'Electronics',
    discountPrice: 100, originalPrice: 120, stock: 10, reserved: 0,
    images: ['img.jpg'], status: 'PUBLISHED', isActive: true,
    shopId: String(shop._id),
    shop: { _id: String(shop._id), name: shop.name, ownerId: shop.ownerId, status: shop.status, showOnPublic: true },
    sellerId: shop.ownerId,
    ratings: 4.5,
    ...overrides,
  };
}

function stubClients() {
  deliveryClient.getLocationHierarchy = async () => ({
    status: 200,
    body: {
      hierarchy: [{
        _id: '64b0000000000000000000a0', name: 'Ethiopia', type: 'country',
        children: [{
          _id: '64b0000000000000000000a9', name: 'Hararghe', type: 'region',
          children: [{
            _id: CITY_ID, name: 'Harar', type: 'city',
            children: [{ _id: SECTOR_ID, name: 'Sector 01', type: 'sector', children: [] }],
          }],
        }],
      }],
    },
  });
  deliveryClient.getLocation = async (id) => ({
    status: 200,
    body: { location: { _id: id, name: 'Sector 01', type: 'sector', isActive: true } },
  });
  deliveryClient.getChildren = async () => ({ status: 200, body: { children: [] } });
  deliveryClient.createDeliveryRequest = async () => ({ status: 201, body: { delivery: { _id: 'd1' } } });
  // Delivery zone catalogue stubs (real service code paths through
  // shopCoverage.service.resolveDestinationZone / assertShopsServeZone).
  const TEST_ZONE = {
    _id: SECTOR_ID, name: 'Harar City Zone', code: 'HZ-CITY',
    status: 'active', lifecycle: 'LIVE', serviceable: true,
  };
  deliveryClient.getZoneSummary = async (id) => ({
    status: 200, ok: true,
    body: { zone: String(id) === String(SECTOR_ID) ? TEST_ZONE : null },
  });
  deliveryClient.getZonesForLocation = async () => ({
    status: 200, ok: true,
    body: { zones: [TEST_ZONE] },
  });

  identityClient.getSellerStatus = async () => ({ status: 200, body: { sellerStatus: 'APPROVED' } });
  identityClient.linkShopId = async () => ({ status: 200, body: {} });
  identityClient.findUser = async () => ({ status: 404, body: {} });
  identityClient.findUserByEmail = async () => ({ status: 404, body: {} });
  identityClient.checkMembershipStatus = async () => ({ status: 200, body: { status: 'ACTIVE' } });
  identityClient.markOnboardingComplete = async () => ({ status: 200, body: {} });
  identityClient.setSellerStatus = async () => ({ status: 200, body: {} });
  identityClient.grantSellerRole = async () => ({ status: 200, body: {} });
}

before(async () => {
  await mongoose.connect(DB_URL);
  Shop = require('../models/Shops');
  SellerApplication = require('../models/SellerApplications');
  Product = require('../../catalog/models/Products');
  Order = require('../../fulfillment/models/Orders');

  shopService = require('../services/shops.service');
  sellerAppService = require('../services/sellerApplications.service');
  businessService = require('../services/business.service');
  shopRepository = require('../repositories/shops.repository');
  sellerAppRepository = require('../repositories/sellerApplications.repository');
  productsService = require('../../catalog/services/products.service');
  orderService = require('../../fulfillment/services/orders.service');
  resolveHierarchyScope = require('../../../shared/utils/hierarchyScope').resolveHierarchyScope;
  identityClient = require('../../../app/clients/identity.client').identityClient;
  deliveryClient = require('../../../app/clients/delivery.client').deliveryClient;

  stubClients();
});

beforeEach(async () => {
  await Promise.all(COLLECTIONS.map((name) => mongoose.connection.db.collection(name).deleteMany({})));
  await Promise.all([Shop.init(), SellerApplication.init(), Product.init(), Order.init()]);
  stubClients();
});

afterEach(async () => {
  await Promise.all(COLLECTIONS.map((name) => mongoose.connection.db.collection(name).deleteMany({})));
});

after(async () => {
  await mongoose.connection.close();
});

// ── Shop -> Business ─────────────────────────────────────────────────────────
describe('Shop → Business', () => {
  it('links a new shop to the owner’s existing business', async () => {
    const business = await createBusiness('seller-a');

    const shop = await shopService.createShop(
      {
        name: 'Linked Shop', email: 'linked@shop.local', address: '1 Street',
        phoneNumber: '911000000', zipCode: '1000',
        avatar: { public_id: 'p', url: '/uploads/p.png' },
      },
      { id: 'seller-a', role: 'SELLER' }
    );

    assert.strictEqual(String(shop.businessId), String(business._id));
    assert.strictEqual(String(shop.applicationId), String(business._id));
    assert.strictEqual(await SellerApplication.countDocuments({ ownerId: 'seller-a' }), 1);
  });

  it('provisions a business when the owner has never filed an application', async () => {
    assert.strictEqual(await SellerApplication.countDocuments({}), 0);

    const shop = await shopService.createShop(
      {
        name: 'Orphan Shop', email: 'orphan@shop.local', address: '1 Street',
        phoneNumber: '911000000', zipCode: '1000',
        avatar: { public_id: 'p', url: '/uploads/p.png' },
      },
      { id: 'seller-new', role: 'SELLER' }
    );

    const created = await SellerApplication.findOne({ ownerId: 'seller-new' }).lean();
    assert.ok(created, 'a business record must exist for the new shop');
    assert.strictEqual(created.provisionedFromShop, true);
    assert.strictEqual(created.status, 'APPROVED');
    assert.strictEqual(created.businessInformation.businessName, 'Orphan Shop');
    assert.strictEqual(String(shop.businessId), String(created._id));
    assert.strictEqual(String(shop.applicationId), String(created._id));
  });

  it('reuses one business for every shop the owner opens', async () => {
    const payload = (name, email) => ({
      name, email, address: '1 Street', phoneNumber: '911000000', zipCode: '1000',
      category: 'Retail', avatar: { public_id: 'p', url: '/uploads/p.png' },
    });

    const first = await shopService.createShop(payload('Store One', 'one@shop.local'), { id: 'seller-multi', role: 'SELLER' });
    const second = await shopService.createShop(payload('Store Two', 'two@shop.local'), { id: 'seller-multi', role: 'SELLER' });

    assert.strictEqual(await SellerApplication.countDocuments({ ownerId: 'seller-multi' }), 1);
    assert.strictEqual(String(first.businessId), String(second.businessId));
  });

  it('resolveShopBusinessId is idempotent for an already-linked shop', async () => {
    const business = await createBusiness('seller-idem');
    const shop = await createShopDoc({ ownerId: 'seller-idem', businessId: String(business._id) });

    const before = shop.updatedAt;
    const resolved = await businessService.resolveShopBusinessId(shop);

    assert.strictEqual(resolved, String(business._id));
    assert.strictEqual(await SellerApplication.countDocuments({}), 1);
    assert.strictEqual(String((await Shop.findById(shop._id)).updatedAt), String(before));
  });
});

// ── Order -> Business ────────────────────────────────────────────────────────
describe('Order → Business', () => {
  it('resolveShipmentBusinessId returns the business id, never the owner’s user id', async () => {
    const business = await createBusiness('seller-order');
    const shop = await createShopDoc({ ownerId: 'seller-order', businessId: String(business._id) });

    const shipmentBusinessId = await businessService.resolveShipmentBusinessId(shop);

    assert.strictEqual(shipmentBusinessId, String(business._id));
    assert.notStrictEqual(shipmentBusinessId, 'seller-order');
  });

  it('falls back to applicationId when businessId was never written', async () => {
    const business = await createBusiness('seller-app-only');
    const shop = await createShopDoc({ ownerId: 'seller-app-only', applicationId: String(business._id) });

    const shipmentBusinessId = await businessService.resolveShipmentBusinessId(shop);

    assert.strictEqual(shipmentBusinessId, String(business._id));
    assert.strictEqual(await SellerApplication.countDocuments({}), 1);
  });

  it('auto-links an unlinked shop while resolving its shipment', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-unlinked' });

    const shipmentBusinessId = await businessService.resolveShipmentBusinessId(shop);

    assert.ok(shipmentBusinessId);
    assert.notStrictEqual(shipmentBusinessId, 'seller-unlinked');
    const reloaded = await Shop.findById(shop._id).lean();
    assert.strictEqual(String(reloaded.businessId), shipmentBusinessId);
    assert.strictEqual(String(reloaded.applicationId), shipmentBusinessId);
  });

  it('a real checkout writes a business id onto the shipment', async () => {
    const business = await createBusiness('seller-checkout');
    const shop = await createShopDoc({
      ownerId: 'seller-checkout',
      businessId: String(business._id),
      // The shop serves the sector's zone — otherwise checkout rejects it.
      deliveryCoverage: {
        zoneIds: [SECTOR_ID],
        zoneNames: [{ id: SECTOR_ID, name: 'Sector 01' }],
        status: 'ACTIVE',
      },
    });
    const product = await Product.create(productDoc(shop));

    const orders = await orderService.createOrder({
      cart: [{ productId: String(product._id), quantity: 1 }],
      shippingAddress: { city: 'Harar', country: 'Ethiopia' },
      user: { _id: 'buyer-1', id: 'buyer-1' },
      paymentInfo: { method: 'COD' },
      destination: {
        regionId: '64b0000000000000000000a9', regionName: 'Hararghe',
        areaId: null, areaName: '',
        cityId: CITY_ID, cityName: 'Harar',
        sectorId: SECTOR_ID, sectorName: 'Sector 01',
        fullAddress: '1 Test Street', phone: '911000000',
      },
    });

    assert.strictEqual(orders.length, 1);
    const shipment = orders[0].sellerShipments[0];
    assert.strictEqual(String(shipment.businessId), String(business._id));
    assert.notStrictEqual(String(shipment.businessId), 'seller-checkout');
    assert.strictEqual(String(shipment.shopId), String(shop._id));
    assert.strictEqual(String(shipment.sellerId), 'seller-checkout');
  });
});

// ── Product ownership / permission isolation ─────────────────────────────────
describe('Product ownership isolation', () => {
  it('lets the owning seller manage their product', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-owner' });
    const product = await Product.create(productDoc(shop));

    await productsService.assertOwnership(product, { id: 'seller-owner', role: 'SELLER' });
  });

  it('refuses a different seller', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-owner' });
    const product = await Product.create(productDoc(shop));

    await assert.rejects(
      () => productsService.assertOwnership(product, { id: 'seller-intruder', role: 'SELLER' }),
      (err) => err.statusCode === 403
    );
  });

  it('refuses an authenticated buyer with no seller link', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-owner' });
    const product = await Product.create(productDoc(shop));

    await assert.rejects(
      () => productsService.assertOwnership(product, { id: 'buyer-9', role: 'BUYER' }),
      (err) => err.statusCode === 403
    );
  });

  it('lets an admin manage any product', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-owner' });
    const product = await Product.create(productDoc(shop));

    await productsService.assertOwnership(product, { id: 'admin-1', role: 'ADMIN' });
  });

  it('follows a shop ownership transfer — the live shop wins over the snapshot', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-old' });
    const product = await Product.create(productDoc(shop)); // snapshot still says seller-old

    await shopRepository.updateOneById(shop._id, { ownerId: 'seller-new' });

    await assert.rejects(
      () => productsService.assertOwnership(product, { id: 'seller-old', role: 'SELLER' }),
      (err) => err.statusCode === 403
    );
    await productsService.assertOwnership(product, { id: 'seller-new', role: 'SELLER' });
  });
});

// ── Admin hierarchy scope ────────────────────────────────────────────────────
describe('Admin business scope', () => {
  it('businessId narrows the shop set to that business only', async () => {
    const mine = await createBusiness('seller-mine');
    const theirs = await createBusiness('seller-theirs');
    await createShopDoc({ ownerId: 'seller-mine', name: 'Mine', businessId: String(mine._id), applicationId: String(mine._id) });
    await createShopDoc({ ownerId: 'seller-theirs', name: 'Theirs', businessId: String(theirs._id), applicationId: String(theirs._id) });

    const scope = await resolveHierarchyScope({ businessId: String(mine._id) });

    assert.strictEqual(scope.scoped, true);
    assert.deepStrictEqual(scope.ownerIds, ['seller-mine']);
    const shops = await shopRepository.find({ filter: scope.shopFilter });
    assert.strictEqual(shops.length, 1);
    assert.strictEqual(shops[0].name, 'Mine');
  });

  it('an unknown businessId matches nothing rather than everything', async () => {
    await createShopDoc({ ownerId: 'seller-x', name: 'Some Shop' });

    const scope = await resolveHierarchyScope({ businessId: '64b000000000000000000dead' });

    assert.strictEqual(scope.scoped, true);
    assert.deepStrictEqual(scope.ownerIds, []);
    const shops = await shopRepository.find({ filter: scope.shopFilter });
    assert.strictEqual(shops.length, 0);
  });

  it('still accepts a legacy businessId that holds a user id', async () => {
    const business = await createBusiness('seller-legacy');
    await createShopDoc({ ownerId: 'seller-legacy', name: 'Legacy Shop', businessId: String(business._id) });
    await createShopDoc({ ownerId: 'seller-other', name: 'Other Shop' });

    const scope = await resolveHierarchyScope({ businessId: 'seller-legacy' });

    assert.strictEqual(scope.scoped, true);
    const shops = await shopRepository.find({ filter: scope.shopFilter });
    assert.strictEqual(shops.length, 1);
    assert.strictEqual(shops[0].name, 'Legacy Shop');
  });

  it('scoping by a shop with no business still resolves through its owner', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-nobiz', name: 'No Biz Yet' });
    await createShopDoc({ ownerId: 'seller-stranger', name: 'Stranger' });

    const scope = await resolveHierarchyScope({ shopId: String(shop._id) });
    const shops = await shopRepository.find({ filter: scope.shopFilter });

    assert.strictEqual(shops.length, 1);
    assert.strictEqual(shops[0].name, 'No Biz Yet');
  });
});

// ── Business record edits ────────────────────────────────────────────────────
describe('Business record edits', () => {
  it('lets the owner fill in a provisioned business (no 409)', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-provisioned' });
    await businessService.resolveShopBusinessId(shop);

    const updated = await sellerAppService.saveApplication('seller-provisioned', {
      sellerType: 'BUSINESS',
      businessInformation: { businessName: 'Real Name Ltd' },
    });

    assert.strictEqual(updated.businessInformation.businessName, 'Real Name Ltd');
    assert.strictEqual(updated.status, 'APPROVED');
  });

  it('still refuses edits to a reviewed business that was not provisioned', async () => {
    await createBusiness('seller-reviewed', { status: 'APPROVED', provisionedFromShop: false });

    await assert.rejects(
      () => sellerAppService.saveApplication('seller-reviewed', { sellerType: 'BUSINESS' }),
      (err) => err.statusCode === 409
    );
  });

  it('approving a provisioned business links its shops instead of duplicating them', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-dup', name: 'Existing Store' });
    const businessId = await businessService.resolveShopBusinessId(shop);
    await sellerAppRepository.updateById(businessId, {
      status: 'PENDING_REVIEW',
      shopInformation: { shopName: 'Existing Store' },
    });

    const shopsBefore = await Shop.countDocuments({ ownerId: 'seller-dup' });
    const result = await sellerAppService.approve(businessId, 'admin-1');

    assert.strictEqual(await Shop.countDocuments({ ownerId: 'seller-dup' }), shopsBefore);
    assert.strictEqual(result.shopWasCreated, false);
    const reloaded = await Shop.findById(shop._id).lean();
    assert.strictEqual(String(reloaded.businessId), String(businessId));
    assert.strictEqual(result.application.status, 'APPROVED');
    assert.strictEqual(result.application.provisionedFromShop, false);
  });
});

// ── Product -> Shop snapshot ─────────────────────────────────────────────────
describe('Product ↔ Shop snapshot', () => {
  it('a renamed shop cascades into the embedded snapshot on its products', async () => {
    const shop = await createShopDoc({ ownerId: 'seller-rename', name: 'Old Name' });
    await Product.create(productDoc(shop));

    await shopService.updateInfo(shop, { name: 'New Name' });

    const product = await Product.findOne({ shopId: String(shop._id) }).lean();
    assert.strictEqual(product.shop.name, 'New Name');
    assert.strictEqual(product.shop.ownerId, 'seller-rename');
  });
});
