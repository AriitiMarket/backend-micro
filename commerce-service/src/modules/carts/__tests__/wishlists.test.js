/**
 * Wishlist Module Tests
 *
 * Uses Node's built-in test runner (`node --test`).
 * Tests cover: model schema, repository methods, service validation.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

let Wishlist;
let Product;
let repo;
let service;

// Dedicated DB so this suite can run in parallel with orders/carts.
const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_wishlists$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_wishlists';

const PID1 = '507f1f77bcf86cd799439011';
const PID2 = '507f1f77bcf86cd799439012';
const PID_MISSING = '507f1f77bcf86cd799439099';

// ── Setup ──────────────────────────────────────────────────────────────
before(async () => {
  await mongoose.connect(DB_URL);
  Wishlist = require('../models/Wishlists');
  Product = require('../../catalog/models/Products');
  // deleteMany + init (not dropDatabase): drop races parallel suite starts
  // (DatabaseDropPending / PRODUCT_NOT_FOUND mid-test).
  await Promise.all([Wishlist.deleteMany({}), Product.deleteMany({})]);
  await Promise.all([Wishlist.init(), Product.init()]);
  repo = require('../repositories/wishlists.repository');
  service = require('../services/wishlists.service');
});

// afterEach deleteMany (NOT dropDatabase): drop races parallel suite starts
// (DatabaseDropPending / PRODUCT_NOT_FOUND / leftover-item assertion fails).
// deleteMany is per-collection and safe between sequential tests.
afterEach(async () => {
  await Promise.all([Wishlist.deleteMany({}), Product.deleteMany({})]);
});

after(async () => {
  await mongoose.connection.close();
});

async function seedProduct(overrides = {}) {
  return Product.create({
    name: 'Test Product',
    description: 'A test product',
    category: 'Electronics',
    discountPrice: 150,
    originalPrice: 200,
    stock: 10,
    reserved: 0,
    images: ['img.jpg'],
    status: 'PUBLISHED',
    isActive: true,
    shopId: 'shop-1',
    shop: { _id: 'shop-1', name: 'Test Shop', status: 'APPROVED', showOnPublic: true },
    ratings: 4.5,
    ...overrides,
  });
}

// ── Model Tests ────────────────────────────────────────────────────────
describe('Wishlist Model Schema', () => {
  it('Wishlist model exists', () => {
    assert.ok(Wishlist);
  });

  it('items auto-generate _id when not provided', () => {
    const w = new Wishlist({
      userId: 'user-1',
      items: [{ productId: PID1, name: 'Test', price: 100 }],
    });
    assert.ok(w.items[0]._id);
    assert.strictEqual(typeof w.items[0]._id, 'string');
  });

  it('item productId is required', () => {
    const w = new Wishlist({
      userId: 'user-1',
      items: [{ name: 'No id', price: 1 }],
    });
    const err = w.validateSync();
    assert.ok(err);
    assert.ok(err.errors['items.0.productId']);
  });

  it('items have createdAt and updatedAt', () => {
    const w = new Wishlist({
      userId: 'user-1',
      items: [{ productId: PID1, name: 'Test', price: 100 }],
    });
    assert.ok(w.items[0].createdAt instanceof Date);
    assert.ok(w.items[0].updatedAt instanceof Date);
  });

  it('document has createdAt', () => {
    const w = new Wishlist({ userId: 'user-1', items: [] });
    assert.ok(w.createdAt instanceof Date);
  });

  it('has unique index on userId + items.productId', () => {
    const idx = Wishlist.schema.indexes().find((i) => i[0] && i[0]['userId'] && i[0]['items.productId']);
    assert.ok(idx, 'compound index missing');
    assert.strictEqual(idx[1].unique, true);
  });
});

// ── Repository Tests ───────────────────────────────────────────────────
describe('Wishlist Repository', () => {
  it('findByUser returns null for non-existent user', async () => {
    const w = await repo.findByUser('nonexistent');
    assert.strictEqual(w, null);
  });

  it('addItem creates new wishlist with one item', async () => {
    const w = await repo.addItem('user-2', { productId: PID1, name: 'Test', price: 100 });
    assert.ok(w);
    assert.strictEqual(w.userId, 'user-2');
    assert.strictEqual(w.items.length, 1);
    assert.strictEqual(w.items[0].productId, PID1);
    assert.strictEqual(w.items[0]._id, PID1);
    assert.strictEqual(w.items[0].name, 'Test');
    assert.strictEqual(w.items[0].price, 100);
  });

  it('addItem prevents duplicate product entries', async () => {
    await repo.addItem('user-3', { productId: PID1, name: 'Test', price: 100 });
    const w = await repo.addItem('user-3', { productId: PID1, name: 'Test', price: 120 });
    assert.strictEqual(w.items.length, 1);
    assert.strictEqual(w.items[0].price, 120);
  });

  it('addItem supports multiple distinct products', async () => {
    await repo.addItem('user-4', { productId: PID1, name: 'A', price: 100 });
    const w = await repo.addItem('user-4', { productId: PID2, name: 'B', price: 200 });
    assert.strictEqual(w.items.length, 2);
  });

  it('findItem returns item for existing product', async () => {
    await repo.addItem('user-5', { productId: PID1, name: 'Test', price: 100 });
    const item = await repo.findItem('user-5', PID1);
    assert.ok(item);
    assert.strictEqual(item.productId, PID1);
  });

  it('findItem returns null for non-existent product', async () => {
    await repo.addItem('user-6', { productId: PID1, name: 'Test', price: 100 });
    const item = await repo.findItem('user-6', PID_MISSING);
    assert.strictEqual(item, null);
  });

  it('findItem returns null when user has no wishlist', async () => {
    const item = await repo.findItem('user-nothing', PID1);
    assert.strictEqual(item, null);
  });

  it('removeItem removes the matching item only', async () => {
    await repo.addItem('user-7', { productId: PID1, name: 'A', price: 100 });
    await repo.addItem('user-7', { productId: PID2, name: 'B', price: 200 });
    const w = await repo.removeItem('user-7', PID1);
    assert.strictEqual(w.items.length, 1);
    assert.strictEqual(w.items[0].productId, PID2);
  });

  it('removeItem returns null when item not found', async () => {
    await repo.addItem('user-8', { productId: PID1, name: 'Test', price: 100 });
    const result = await repo.removeItem('user-8', PID_MISSING);
    assert.strictEqual(result, null);
  });

  it('removeItem returns null when user has no wishlist', async () => {
    const result = await repo.removeItem('user-nothing', PID1);
    assert.strictEqual(result, null);
  });

  it('clear deletes the wishlist document', async () => {
    await repo.addItem('user-9', { productId: PID1, name: 'Test', price: 100 });
    const deleted = await repo.clear('user-9');
    assert.strictEqual(deleted.items.length, 1);
    const found = await repo.findByUser('user-9');
    assert.strictEqual(found, null);
  });

  it('clear returns null when there is nothing to clear', async () => {
    const deleted = await repo.clear('user-nothing');
    assert.strictEqual(deleted, null);
  });
});

// ── Service Tests ──────────────────────────────────────────────────────
describe('Wishlist Service', () => {
  it('addItem throws 400 for invalid product ID', async () => {
    try {
      await service.addItem('user-1', { productId: 'not-an-id', name: 'Fake', price: 999 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Invalid product ID');
      assert.strictEqual(err.statusCode, 400);
    }
  });

  it('addItem throws 404 when product not found', async () => {
    try {
      await service.addItem('user-1', { productId: PID_MISSING, name: 'Ghost', price: 1 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Product not found');
      assert.strictEqual(err.statusCode, 404);
    }
  });

  it('addItem throws 404 when product is out of stock (unavailable)', async () => {
    const product = await seedProduct({ stock: 0 });
    try {
      await service.addItem('user-1', { productId: product._id.toString() });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Product is no longer available');
      assert.strictEqual(err.statusCode, 404);
    }
  });

  it('addItem throws 404 when product is deactivated', async () => {
    const product = await seedProduct({ isActive: false });
    try {
      await service.addItem('user-1', { productId: product._id.toString() });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Product is no longer available');
    }
  });

  it('addItem uses authoritative product data, ignoring client name/price', async () => {
    const product = await seedProduct();
    const w = await service.addItem('user-10', {
      productId: product._id.toString(),
      name: 'TOTALLY FAKE NAME',
      price: 999999,
    });
    assert.strictEqual(w.items.length, 1);
    const item = w.items[0];
    assert.strictEqual(item.name, 'Test Product');
    assert.strictEqual(item.price, 150);
    assert.strictEqual(item.originalPrice, 200);
    assert.strictEqual(item.image, 'img.jpg');
    assert.strictEqual(item.shopName, 'Test Shop');
    assert.strictEqual(item.stock, 10);
  });

  it('addItem is idempotent for the same product', async () => {
    const product = await seedProduct();
    const pid = product._id.toString();
    await service.addItem('user-11', { productId: pid });
    const w = await service.addItem('user-11', { productId: pid });
    assert.strictEqual(w.items.length, 1);
  });

  it('getUserWishlist returns null when nothing is wishlisted', async () => {
    const w = await service.getUserWishlist('user-nothing');
    assert.strictEqual(w, null);
  });

  it('isWishlisted reports true after add and false after remove', async () => {
    const product = await seedProduct();
    const pid = product._id.toString();

    let result = await service.isWishlisted('user-12', pid);
    assert.strictEqual(result.wishlisted, false);

    await service.addItem('user-12', { productId: pid });
    result = await service.isWishlisted('user-12', pid);
    assert.strictEqual(result.wishlisted, true);
    assert.ok(result.item);

    await service.removeItem('user-12', pid);
    result = await service.isWishlisted('user-12', pid);
    assert.strictEqual(result.wishlisted, false);
  });

  it('isWishlisted throws 400 for invalid product ID', async () => {
    try {
      await service.isWishlisted('user-1', 'bad-id');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.statusCode, 400);
    }
  });

  it('removeItem returns the wishlist after removal (empty items)', async () => {
    const product = await seedProduct();
    const pid = product._id.toString();
    await service.addItem('user-13', { productId: pid });
    const w = await service.removeItem('user-13', pid);
    assert.ok(w);
    assert.strictEqual(w.items.length, 0);
  });

  it('removeItem returns null when item not in wishlist', async () => {
    const w = await service.removeItem('user-14', PID1);
    assert.strictEqual(w, null);
  });

  it('clearWishlist deletes the document', async () => {
    const product = await seedProduct();
    await service.addItem('user-15', { productId: product._id.toString() });
    await service.clearWishlist('user-15');
    const w = await service.getUserWishlist('user-15');
    assert.strictEqual(w, null);
  });

  it('user isolation: user A wishlist is invisible to user B', async () => {
    const product = await seedProduct();
    const pid = product._id.toString();
    await service.addItem('user-A', { productId: pid });

    const aWishlist = await service.getUserWishlist('user-A');
    const bWishlist = await service.getUserWishlist('user-B');
    assert.strictEqual(aWishlist.items.length, 1);
    assert.strictEqual(bWishlist, null);

    const bCheck = await service.isWishlisted('user-B', pid);
    assert.strictEqual(bCheck.wishlisted, false);
  });
});
