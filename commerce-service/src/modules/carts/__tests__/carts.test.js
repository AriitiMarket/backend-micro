/**
 * Cart Module Tests
 *
 * Uses Node's built-in test runner (`node --test`).
 * Tests cover: model schema, repository methods, service validation.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

let Cart;
let repo;
let service;

// Dedicated DB so this suite can run in parallel with orders/wishlists.
const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_carts$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_carts';

// ── Setup ──────────────────────────────────────────────────────────────
before(async () => {
  await mongoose.connect(DB_URL);
  Cart = require('../models/Carts');
  // deleteMany + init (not dropDatabase): drop races parallel suite starts
  // (DatabaseDropPending) and index build mid-test causes VersionError flakes.
  await Cart.deleteMany({});
  await Cart.init();
  repo = require('../repositories/carts.repository');
  service = require('../services/carts.service');
});

// afterEach deleteMany (NOT dropDatabase): drop races parallel suite starts
// (DatabaseDropPending / VersionError). deleteMany is per-collection and safe
// between sequential tests; unique userIds still isolate concurrent readers.
afterEach(async () => {
  await Cart.deleteMany({});
});

after(async () => {
  await mongoose.connection.close();
});

// ── Model Tests ────────────────────────────────────────────────────────
describe('Cart Model Schema', () => {
  it('Cart model exists', () => {
    assert.ok(Cart);
  });

  it('Cart items auto-generate _id when not provided', async () => {
    const cart = new Cart({
      userId: 'user-1',
      items: [{ productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 }],
    });
    assert.ok(cart.items[0]._id);
    assert.strictEqual(typeof cart.items[0]._id, 'string');
  });

  it('Cart items have createdAt', async () => {
    const cart = new Cart({
      userId: 'user-1',
      items: [{ productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 }],
    });
    assert.ok(cart.items[0].createdAt);
    assert.ok(cart.items[0].createdAt instanceof Date);
  });

  it('Cart items have updatedAt', async () => {
    const cart = new Cart({
      userId: 'user-1',
      items: [{ productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 }],
    });
    assert.ok(cart.items[0].updatedAt);
  });

  it('Cart does NOT have qty field', async () => {
    const cart = new Cart({
      userId: 'user-1',
      items: [{ productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 }],
    });
    assert.strictEqual(cart.items[0].qty, undefined);
  });

  it('Cart has unique index on userId + items.productId', () => {
    const indexes = Cart.schema.indexes();
    const hasUniqueIndex = indexes.some((idx) => idx[0] && idx[0]['userId'] && idx[0]['items.productId']);
    assert.ok(hasUniqueIndex);
  });
});

// ── Repository Tests ───────────────────────────────────────────────────
describe('Cart Repository', () => {
  it('findByUser returns null for non-existent user', async () => {
    const cart = await repo.findByUser('nonexistent');
    assert.strictEqual(cart, null);
  });

  it('addItem creates new cart with items', async () => {
    const cart = await repo.addItem('user-2', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 3 });
    assert.ok(cart);
    assert.strictEqual(cart.userId, 'user-2');
    assert.strictEqual(cart.items.length, 1);
    assert.strictEqual(cart.items[0].quantity, 3);
  });

  it('addItem merges quantity for duplicate product', async () => {
    await repo.addItem('user-3', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    const cart = await repo.addItem('user-3', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 3 });
    assert.strictEqual(cart.items.length, 1);
    assert.strictEqual(cart.items[0].quantity, 5);
  });

  it('addItem generates _id for items', async () => {
    const cart = await repo.addItem('user-4', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 1 });
    assert.ok(cart.items[0]._id);
    assert.strictEqual(typeof cart.items[0]._id, 'string');
  });

  it('findCartItem returns item for existing product', async () => {
    const pid = '507f1f77bcf86cd799439011';
    await repo.addItem('user-5', { productId: pid, shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    const item = await repo.findCartItem('user-5', pid);
    assert.ok(item);
    assert.strictEqual(item.productId, pid);
  });

  it('findCartItem returns null for non-existent product', async () => {
    await repo.addItem('user-6', { productId: '507f1f77bcf86cd799439012', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    const item = await repo.findCartItem('user-6', '507f1f77bcf86cd799439013');
    assert.strictEqual(item, null);
  });

  it('updateItemQuantity updates item quantity', async () => {
    await repo.addItem('user-7', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    const cart = await repo.updateItemQuantity('user-7', 'prod-1', 5);
    assert.strictEqual(cart.items[0].quantity, 5);
  });

  it('updateItemQuantity returns null for non-existent item', async () => {
    const result = await repo.updateItemQuantity('user-8', 'nonexistent', 1);
    assert.strictEqual(result, null);
  });

  it('removeItem removes item from cart', async () => {
    await repo.addItem('user-9', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    await repo.addItem('user-9', { productId: 'prod-2', shopId: 'shop-1', name: 'Test2', price: 200, quantity: 1 });
    const cart = await repo.removeItem('user-9', 'prod-1');
    assert.strictEqual(cart.items.length, 1);
    assert.strictEqual(cart.items[0].productId, 'prod-2');
  });

  it('removeItem returns null when item not found', async () => {
    await repo.addItem('user-10', { productId: 'prod-1', shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    const result = await repo.removeItem('user-10', 'nonexistent');
    assert.strictEqual(result, null);
  });

  it('clear removes all items', async () => {
    const pid = '507f1f77bcf86cd799439011';
    await repo.addItem('user-11', { productId: pid, shopId: 'shop-1', name: 'Test', price: 100, quantity: 2 });
    const cart = await repo.clear('user-11');
    assert.strictEqual(cart.items.length, 1);
    const found = await repo.findByUser('user-11');
    assert.strictEqual(found, null);
  });
});

// ── Service Validation Tests ───────────────────────────────────────────
describe('Cart Service', () => {
  it('addItem throws for invalid product ID', async () => {
    try {
      await service.addItem('user-1', { productId: 'invalid-id', shopId: 'shop-1', name: 'Test', price: 100, quantity: 1 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Invalid product ID');
    }
  });

  it('addItem throws for quantity < 1', async () => {
    try {
      await service.addItem('user-1', { productId: '507f1f77bcf86cd799439011', shopId: 'shop-1', name: 'Test', price: 100, quantity: 0 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Quantity') || err.message.includes('product'));
    }
  });

  it('addItem throws when product not found', async () => {
    try {
      await service.addItem('user-1', { productId: '507f1f77bcf86cd799439012', shopId: 'shop-1', name: 'Test', price: 100, quantity: 1 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Product not found');
    }
  });
});
