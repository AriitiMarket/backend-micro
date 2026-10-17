/**
 * Cart zone-aware validation tests.
 *
 * Stubs the cart/product/shop repositories and the Delivery client so the suite
 * never depends on another service or the database — the REAL validation logic
 * runs (Rule A + Rule C).
 */
const assert = require('assert');
const { describe, it, before, afterEach } = require('node:test');

const cartService = require('../services/carts.service');
const shopCoverageService = require('../../selling/services/shopCoverage.service');
const productRepository = require('../../catalog/repositories/products.repository');
const shopRepository = require('../../selling/repositories/shops.repository');

let Cart;
let Product;
let Shop;
let deliveryClient;

const TEST_ZONE_ID = 'zone-harar-city';
const TEST_ZONE = { _id: TEST_ZONE_ID, name: 'Harar City Zone', status: 'active', lifecycle: 'LIVE', serviceable: true };

const PRODUCT_ID = 'prod-a';
const SHOP_ID = 'shop-harar';

async function stubClients() {
  deliveryClient = require('../../../app/clients/delivery.client').deliveryClient;
  deliveryClient.getZoneSummary = async () => ({ status: 200, ok: true, body: { zone: TEST_ZONE } });

  const cartsByUser = new Map();
  const productsById = new Map();
  const shopsById = new Map();

  Cart.findOne = (filter) => ({
    // Fake Mongoose query — the real `findByUser` is `Cart.findOne({ userId }).lean()`,
    // called synchronously, so the stub must return the query object directly.
    lean: () => cartsByUser.get(filter && filter.userId),
  });
  // The repository class methods guard non-ObjectId ids (legacy string ids),
  // so stub the class methods directly to serve the test fixtures.
  productRepository.findById = async (id) => productsById.get(String(id)) || null;
  shopRepository.findById = async (id) => shopsById.get(String(id)) || null;

  return { cartsByUser, productsById, shopsById };
}

const SHOP_DOC = {
  _id: SHOP_ID, name: 'Harar Electronics', status: 'APPROVED',
  deliveryCoverage: {
    zoneIds: [TEST_ZONE_ID],
    zoneNames: [{ id: TEST_ZONE_ID, name: 'Harar City Zone' }],
    status: 'ACTIVE',
  },
};

function product(pid, overrides = {}) {
  return {
    _id: pid, name: 'Product A', price: 100, discountPrice: 100, stock: 10, reserved: 0,
    status: 'PUBLISHED', isActive: true, shopId: SHOP_ID,
    shop: { _id: SHOP_ID, name: 'Harar Electronics', status: 'APPROVED', showOnPublic: true },
    ...overrides,
  };
}

describe('Cart zone-aware validation (validateForZone)', () => {
  let stores;
  before(async () => {
    const mongoose = require('mongoose');
    await mongoose.connect('mongodb://localhost:27017/ariti_commerce_test_zone_validation');
    Cart = require('../models/Carts');
    Product = require('../../catalog/models/Products');
    Shop = require('../../selling/models/Shops');
    stores = await stubClients();
    await Cart.deleteMany({});
    await Product.deleteMany({});
    await Shop.deleteMany({});
  });
  afterEach(async () => {
    stores = await stubClients();
    stores.cartsByUser.clear();
    stores.productsById.clear();
    stores.shopsById.set(SHOP_ID, SHOP_DOC);
  });

  it('empty cart → valid', async () => {
    stores.cartsByUser.set('user-empty', null);
    const result = await cartService.validateForZone('user-empty', { zoneId: TEST_ZONE_ID });
    assert.equal(result.valid, true);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.issues, []);
  });

  it('no zone selected → INVALID_DELIVERY_LOCATION', async () => {
    stores.cartsByUser.set('user-z', { items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, name: 'A', price: 100, quantity: 1 }] });
    stores.productsById.set(PRODUCT_ID, product(PRODUCT_ID));
    const result = await cartService.validateForZone('user-z', { zoneId: '' });
    assert.equal(result.valid, false);
    assert.equal(result.issues[0].code, 'INVALID_DELIVERY_LOCATION');
    assert.equal(result.items[0].eligible, false);
  });

  it('item from a shop serving the zone → eligible', async () => {
    stores.cartsByUser.set('user-ok', { items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, name: 'A', price: 100, quantity: 1 }] });
    stores.productsById.set(PRODUCT_ID, product(PRODUCT_ID));
    stores.shopsById.set(SHOP_ID, SHOP_DOC);
    const result = await cartService.validateForZone('user-ok', { zoneId: TEST_ZONE_ID, zoneName: 'Harar City Zone' });
    assert.equal(result.valid, true);
    assert.equal(result.items[0].eligible, true);
    assert.equal(result.zone.id, TEST_ZONE_ID);
    assert.equal(result.zone.verified, true);
  });

  it('item from a shop with no coverage → LOCATION_NOT_CONFIGURED (cart kept intact)', async () => {
    stores.cartsByUser.set('user-nc', { items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, name: 'A', price: 100, quantity: 1 }] });
    stores.productsById.set(PRODUCT_ID, product(PRODUCT_ID));
    stores.shopsById.set(SHOP_ID, { _id: SHOP_ID, name: 'Harar Electronics', status: 'APPROVED',
      deliveryCoverage: { zoneIds: [], zoneNames: [], status: 'UNCONFIGURED' } });
    const result = await cartService.validateForZone('user-nc', { zoneId: TEST_ZONE_ID, zoneName: 'Harar City Zone' });
    assert.equal(result.valid, false);
    assert.equal(result.items[0].code, 'LOCATION_NOT_CONFIGURED');
    assert.equal(result.items[0].eligible, false);
    assert.ok(result.issues[0].message.includes('no delivery coverage configured'));
  });

  it('item from a shop serving a different zone → SHOP_NOT_SERVING_ZONE', async () => {
    stores.cartsByUser.set('user-mismatch', { items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, name: 'A', price: 100, quantity: 1 }] });
    stores.productsById.set(PRODUCT_ID, product(PRODUCT_ID));
    stores.shopsById.set(SHOP_ID, { _id: SHOP_ID, name: 'Harar Electronics', status: 'APPROVED',
      deliveryCoverage: { zoneIds: ['zone-other'], zoneNames: [{ id: 'zone-other', name: 'Other Zone' }], status: 'ACTIVE' } });
    const result = await cartService.validateForZone('user-mismatch', { zoneId: TEST_ZONE_ID, zoneName: 'Harar City Zone' });
    assert.equal(result.valid, false);
    assert.equal(result.items[0].code, 'SHOP_NOT_SERVING_ZONE');
    assert.ok(result.items[0].message.includes('does not deliver'));
  });

  it('product unavailable → PRODUCT_UNAVAILABLE', async () => {
    stores.cartsByUser.set('user-unavail', { items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, name: 'A', price: 100, quantity: 1 }] });
    stores.productsById.set(PRODUCT_ID, null);
    const result = await cartService.validateForZone('user-unavail', { zoneId: TEST_ZONE_ID });
    assert.equal(result.valid, false);
    assert.equal(result.items[0].code, 'PRODUCT_UNAVAILABLE');
  });

  it('price changed → priceChanged flag with current price', async () => {
    stores.cartsByUser.set('user-price', { items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, name: 'A', price: 100, quantity: 1 }] });
    stores.productsById.set(PRODUCT_ID, product(PRODUCT_ID, { discountPrice: 120 }));
    const result = await cartService.validateForZone('user-price', { zoneId: TEST_ZONE_ID });
    assert.equal(result.valid, true);
    assert.equal(result.items[0].priceChanged, true);
    assert.equal(result.items[0].currentPrice, 120);
  });
});