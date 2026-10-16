/**
 * Best-selling products tests.
 *
 * Covers: ranking from real qualifying sales, exclusion of cancelled /
 * unpaid / refunded orders, deterministic tie-breaking, public visibility
 * gating, empty results, and validated limit / days inputs.
 *
 * Uses Node's built-in test runner (`node --test`).
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

// Dedicated DB so this suite can run in parallel with other suites.
const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_bestsellers$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_bestsellers';

let Order;
let Product;
let findBestSelling;
let ORDER_STATUSES;

const SHOP_ID = 'shop-best-1';
const SELLER_ID = 'seller-best-1';

const PUBLIC_SHOP = {
  _id: SHOP_ID,
  name: 'Best Seller Shop',
  status: 'APPROVED',
  showOnPublic: true,
};

async function seedProduct(overrides = {}) {
  return Product.create({
    name: 'Best Seller Test Product',
    description: 'A test product',
    category: 'Electronics',
    discountPrice: 100,
    originalPrice: 120,
    stock: 10,
    reserved: 0,
    images: ['img.jpg'],
    status: 'PUBLISHED',
    isActive: true,
    shopId: SHOP_ID,
    shop: PUBLIC_SHOP,
    sellerId: SELLER_ID,
    ratings: 4.5,
    ...overrides,
  });
}

async function seedOrder({ product, quantity = 2, status = 'Delivered', paymentStatus = 'CONFIRMED', createdAt } = {}) {
  const p = product || (await seedProduct());
  return Order.create({
    buyerId: 'buyer-1',
    user: { id: 'buyer-1', email: 'buyer@test.com' },
    sellerId: SELLER_ID,
    shopId: SHOP_ID,
    cart: [
      {
        _id: String(p._id),
        productId: String(p._id),
        name: p.name,
        quantity,
        discountPrice: p.discountPrice,
        price: p.discountPrice,
        subtotal: p.discountPrice * quantity,
        shopId: SHOP_ID,
        sellerId: SELLER_ID,
      },
    ],
    subtotal: p.discountPrice * quantity,
    shippingFee: 3,
    totalPrice: p.discountPrice * quantity + 3,
    status,
    paymentStatus,
    createdAt: createdAt || new Date(),
    updatedAt: new Date(),
  });
}

describe('Best-selling products', () => {
  before(async () => {
    await mongoose.connect(DB_URL);
    ORDER_STATUSES = require('../../fulfillment/constants/orderStatuses').ORDER_STATUSES;
    Order = require('../../fulfillment/models/Orders');
    Product = require('../models/Products');
    findBestSelling = require('../repositories/products.public.repository').findBestSelling;
    await Promise.all([Order.deleteMany({}), Product.deleteMany({})]);
    await Promise.all([Order.init(), Product.init()]);
  });

  afterEach(async () => {
    await Promise.all([Order.deleteMany({}), Product.deleteMany({})]);
  });

  after(async () => {
    await mongoose.connection.close();
  });

  describe('ranking from real qualifying sales', () => {
    it('ranks products by units sold in descending order', async () => {
      const pA = await seedProduct({ name: 'Product A', stock: 100 });
      const pB = await seedProduct({ name: 'Product B', stock: 100 });
      const pC = await seedProduct({ name: 'Product C', stock: 100 });

      await seedOrder({ product: pA, quantity: 4 });
      await seedOrder({ product: pA, quantity: 6 });
      await seedOrder({ product: pB, quantity: 7 });
      await seedOrder({ product: pC, quantity: 3 });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 3);
      assert.strictEqual(result.products[0].name, 'Product A');
      assert.strictEqual(result.products[0].unitsSold, 10);
      assert.strictEqual(result.products[1].name, 'Product B');
      assert.strictEqual(result.products[1].unitsSold, 7);
      assert.strictEqual(result.products[2].name, 'Product C');
      assert.strictEqual(result.products[2].unitsSold, 3);
    });

    it('only counts Confirmed/Delivered orders with CONFIRMED payment', async () => {
      const p = await seedProduct({ name: 'Qualifying Product', stock: 100 });

      await seedOrder({ product: p, quantity: 5, status: 'Delivered', paymentStatus: 'CONFIRMED' });
      await seedOrder({ product: p, quantity: 99, status: 'Delivered', paymentStatus: 'PENDING' });
      await seedOrder({ product: p, quantity: 99, status: 'Cancelled', paymentStatus: 'CONFIRMED' });
      await seedOrder({ product: p, quantity: 99, status: 'Processing', paymentStatus: 'CONFIRMED' });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].unitsSold, 5);
    });

    it('excludes refunded orders', async () => {
      const p = await seedProduct({ name: 'Refunded Product', stock: 100 });

      await seedOrder({ product: p, quantity: 5, status: 'Delivered', paymentStatus: 'CONFIRMED' });
      await seedOrder({ product: p, quantity: 99, status: 'Delivered', paymentStatus: 'REFUNDED' });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].unitsSold, 5);
    });
  });

  describe('deterministic ordering', () => {
    it('breaks equal sales ties by createdAt descending (newest first)', async () => {
      const pA = await seedProduct({ name: 'Older Product', stock: 100 });
      const pB = await seedProduct({ name: 'Newer Product', stock: 100 });

      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const newDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

      await seedOrder({ product: pA, quantity: 5, createdAt: oldDate });
      await seedOrder({ product: pB, quantity: 5, createdAt: newDate });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 2);
      assert.strictEqual(result.products[0].name, 'Newer Product');
      assert.strictEqual(result.products[1].name, 'Older Product');
    });
  });

  describe('time window', () => {
    it('only counts orders within the requested window', async () => {
      const p = await seedProduct({ name: 'Window Product', stock: 100 });

      await seedOrder({ product: p, quantity: 5, createdAt: new Date() });
      await seedOrder({ product: p, quantity: 99, createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].unitsSold, 5);
    });

    it('respects a custom days window', async () => {
      const p = await seedProduct({ name: 'Custom Window Product', stock: 100 });

      await seedOrder({ product: p, quantity: 5, createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });

      const within30 = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(within30.products[0].unitsSold, 5);

      const within5 = await findBestSelling({ limit: 10, days: 5 });
      assert.strictEqual(within5.products.length, 0);
    });
  });

  describe('public visibility gate', () => {
    it('excludes products that are no longer public', async () => {
      const publicP = await seedProduct({ name: 'Public Product', stock: 100 });
      const draftP = await seedProduct({
        name: 'Draft Product',
        stock: 100,
        status: 'DRAFT',
      });
      const inactiveP = await seedProduct({
        name: 'Inactive Product',
        stock: 100,
        isActive: false,
      });

      await seedOrder({ product: publicP, quantity: 5 });
      await seedOrder({ product: draftP, quantity: 99 });
      await seedOrder({ product: inactiveP, quantity: 99 });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].name, 'Public Product');
    });

    it('excludes products whose shop is not in good standing', async () => {
      const publicP = await seedProduct({ name: 'Public Product', stock: 100 });
      const suspendedP = await seedProduct({
        name: 'Suspended Shop Product',
        stock: 100,
        shop: { ...PUBLIC_SHOP, status: 'SUSPENDED' },
      });

      await seedOrder({ product: publicP, quantity: 5 });
      await seedOrder({ product: suspendedP, quantity: 99 });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].name, 'Public Product');
    });
  });

  describe('empty results and validation', () => {
    it('returns an empty list when there are no qualifying sales', async () => {
      await seedProduct({ name: 'No Sales Product', stock: 100 });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.strictEqual(result.products.length, 0);
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.total, 0);
      assert.strictEqual(result.totalPages, 0);
    });

    it('clamps limit to a sane maximum', async () => {
      const p = await seedProduct({ name: 'Limit Product', stock: 100 });
      await seedOrder({ product: p, quantity: 1 });

      const result = await findBestSelling({ limit: 1000, days: 30 });
      assert.strictEqual(result.limit, 50);
    });

    it('clamps limit to a minimum of 1', async () => {
      const p = await seedProduct({ name: 'Min Limit Product', stock: 100 });
      await seedOrder({ product: p, quantity: 1 });

      const result = await findBestSelling({ limit: 0, days: 30 });
      assert.strictEqual(result.limit, 1);
    });

    it('defaults days to 30 when not provided', async () => {
      const p = await seedProduct({ name: 'Default Days Product', stock: 100 });

      await seedOrder({ product: p, quantity: 3, createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) });

      const result = await findBestSelling({ limit: 10 });
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].unitsSold, 3);
    });
  });

  describe('response envelope consistency', () => {
    it('returns the same envelope shape as the public listing', async () => {
      const p = await seedProduct({ name: 'Envelope Product', stock: 100 });
      await seedOrder({ product: p, quantity: 2 });

      const result = await findBestSelling({ limit: 10, days: 30 });
      assert.ok('products' in result);
      assert.ok('count' in result);
      assert.ok('total' in result);
      assert.ok('page' in result);
      assert.ok('limit' in result);
      assert.ok('totalPages' in result);
      assert.strictEqual(result.page, 1);
      assert.ok(Array.isArray(result.products));
      if (result.products.length > 0) {
        assert.ok('unitsSold' in result.products[0]);
        assert.ok('_id' in result.products[0]);
        assert.ok('name' in result.products[0]);
      }
    });
  });
});