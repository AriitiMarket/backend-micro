/**
 * Shop public visibility tests — DEFECT-002.
 *
 * Verifies that public shop productCount and ratings only reflect publicly
 * visible products — never draft/archived products, products of
 * suspended/rejected shops, products in inactive categories, or fully
 * reserved stock. Only 'approved' moderation-status reviews count.
 *
 * Uses Node's built-in runner (`node --test`) against a dedicated test DB.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_shop_visibility_test$1')
  : 'mongodb://localhost:27017/ariti_commerce_shop_visibility_test';

let Shop;
let Product;
let computeProductCountsByShop;
let computeShopRatings;
let findPublicById;
let findPublicAll;

const SHOP_APPROVED = {
  name: 'Approved Shop',
  email: 'approved@test.local',
  address: '1 Approved Street',
  phoneNumber: 911000001,
  zipCode: 1001,
  ownerId: 'owner-vis-1',
  status: 'APPROVED',
  avatar: { public_id: 'a', url: '/uploads/a.png' },
  showOnPublic: true,
};

const SHOP_SUSPENDED = {
  name: 'Suspended Shop',
  email: 'suspended@test.local',
  address: '2 Suspended Street',
  phoneNumber: 911000002,
  zipCode: 1002,
  ownerId: 'owner-vis-2',
  status: 'SUSPENDED',
  avatar: { public_id: 's', url: '/uploads/s.png' },
  showOnPublic: true,
};

async function seedShop(doc = {}) {
  return Shop.create({ ...SHOP_APPROVED, ...doc });
}

async function seedProduct(shopId, overrides = {}) {
  return Product.create({
    name: 'Visibility Test Product',
    description: 'A test product',
    category: 'Electronics',
    discountPrice: 100,
    originalPrice: 120,
    stock: 10,
    reserved: 0,
    images: ['img.jpg'],
    status: 'PUBLISHED',
    isActive: true,
    shopId,
    shop: { _id: shopId, name: 'Test Shop', status: 'APPROVED', showOnPublic: true },
    sellerId: 'seller-vis-1',
    ratings: 4.5,
    ...overrides,
  });
}

async function seedReview(productId, rating, moderationStatus = 'approved') {
  await Product.findByIdAndUpdate(productId, {
    $push: {
      reviews: {
        user: { name: 'Reviewer' },
        rating,
        comment: 'Good product',
        moderationStatus,
        createdAt: new Date(),
      },
    },
  });
}

describe('Shop public visibility (DEFECT-002)', () => {
  before(async () => {
    await mongoose.connect(DB_URL);
    Shop = require('../models/Shops');
    Product = require('../../catalog/models/Products');
    const repo = require('../repositories/shops.public.repository');
    computeProductCountsByShop = repo.computeProductCountsByShop;
    computeShopRatings = repo.computeShopRatings;
    findPublicById = repo.findPublicById;
    findPublicAll = repo.findPublicAll;
    await Promise.all([Shop.deleteMany({}), Product.deleteMany({})]);
    await Promise.all([Shop.init(), Product.init()]);
  });

  afterEach(async () => {
    await Promise.all([Shop.deleteMany({}), Product.deleteMany({})]);
  });

  after(async () => {
    await mongoose.connection.close();
  });

  describe('computeProductCountsByShop', () => {
    it('counts only publicly visible products per shop', async () => {
      const shop = await seedShop();
      await seedProduct(shop._id, { stock: 10, reserved: 0 });
      await seedProduct(shop._id, { status: 'DRAFT', stock: 10, reserved: 0 });
      await seedProduct(shop._id, { status: 'ARCHIVED', stock: 10, reserved: 0 });
      await seedProduct(shop._id, { isActive: false, stock: 10, reserved: 0 });
      await seedProduct(shop._id, { stock: 0, reserved: 0 });

      const counts = await computeProductCountsByShop();
      assert.strictEqual(counts.get(String(shop._id)), 1);
    });

    it('excludes products of suspended shops', async () => {
      const suspendedShop = await seedShop({ ...SHOP_SUSPENDED });
      const publicShop = await seedShop();

      await seedProduct(suspendedShop._id, {
        stock: 10,
        reserved: 0,
        shop: { _id: suspendedShop._id, name: 'Suspended Shop', status: 'SUSPENDED', showOnPublic: true },
      });
      await seedProduct(publicShop._id, { stock: 10, reserved: 0 });

      const counts = await computeProductCountsByShop();
      assert.ok(!counts.has(String(suspendedShop._id)), 'suspended shop should have no visible products');
      assert.strictEqual(counts.get(String(publicShop._id)), 1);
    });

    it('excludes products with stock <= reserved', async () => {
      const shop = await seedShop();
      await seedProduct(shop._id, { stock: 5, reserved: 5 });
      await seedProduct(shop._id, { stock: 10, reserved: 0 });

      const counts = await computeProductCountsByShop();
      assert.strictEqual(counts.get(String(shop._id)), 1);
    });
  });

  describe('computeShopRatings', () => {
    it('only counts approved reviews of publicly visible products', async () => {
      const shop = await seedShop();
      const p1 = await seedProduct(shop._id, { stock: 10, reserved: 0 });
      const p2 = await seedProduct(shop._id, { stock: 10, reserved: 0 });

      await seedReview(p1._id, 5);
      await seedReview(p1._id, 3);
      await seedReview(p1._id, 1, 'pending');
      await seedReview(p1._id, 2, 'rejected');

      const pDraft = await seedProduct(shop._id, { status: 'DRAFT', stock: 10, reserved: 0 });
      await seedReview(pDraft._id, 5);

      const ratings = await computeShopRatings();
      const entry = ratings.get(String(shop._id));
      assert.ok(entry, 'shop should have a ratings entry');
      assert.strictEqual(entry.ratingCount, 2);
      assert.strictEqual(entry.ratings, 4);
    });

    it('returns no entry for shops with no approved public reviews', async () => {
      const shop = await seedShop();
      const p = await seedProduct(shop._id, { stock: 10, reserved: 0 });
      await seedReview(p._id, 5, 'pending');

      const ratings = await computeShopRatings();
      assert.strictEqual(ratings.has(String(shop._id)), false);
    });
  });

  describe('findPublicById', () => {
    it('excludes non-public products from shop detail enrichment', async () => {
      const shop = await seedShop();
      await seedProduct(shop._id, { name: 'Public Product', stock: 10, reserved: 0 });
      await seedProduct(shop._id, { name: 'Draft Product', status: 'DRAFT', stock: 10, reserved: 0 });
      await seedProduct(shop._id, { name: 'Archived Product', status: 'ARCHIVED', stock: 10, reserved: 0 });

      const shopDetail = await findPublicById(String(shop._id));
      assert.ok(shopDetail, 'shop should be found');
      assert.strictEqual(shopDetail.productCount, 1);
      assert.strictEqual(shopDetail.ratingCount, 0);
    });

    it('returns null for a shop that is not publicly visible', async () => {
      const suspendedShop = await seedShop({ ...SHOP_SUSPENDED });

      const result = await findPublicById(String(suspendedShop._id));
      assert.strictEqual(result, null);
    });
  });

  describe('findPublicAll', () => {
    it('excludes non-public products from inflated counts', async () => {
      const shop = await seedShop();
      await seedProduct(shop._id, { status: 'DRAFT', stock: 10, reserved: 0 });

      const result = await findPublicAll({ limit: 10, page: 1 });
      const foundShop = result.shops.find((s) => String(s._id) === String(shop._id));
      assert.ok(foundShop, 'shop should still appear in list');
      assert.strictEqual(foundShop.productCount, 0);
    });
  });
});
