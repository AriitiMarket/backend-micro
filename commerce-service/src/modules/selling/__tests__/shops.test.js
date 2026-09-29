/**
 * Shops module tests — ownership, visibility, allowlist, location validation.
 *
 * Uses Node's built-in runner (`node --test`) against a dedicated test database.
 * The Delivery and Identity clients are stubbed: these tests must never depend
 * on another service being up, but they do exercise the REAL service code, so a
 * regression in the ownership/visibility rules fails the suite.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');

const DB_URL = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/ariti_commerce_shops_test';

process.env.MONGODB_URI = DB_URL;

let Shop;
let Product;
let shopRepository;
let shopService;
let deliveryClient;
let validators;

// ── Stubs ──────────────────────────────────────────────────────────────────
const LOCATION_ID = '64b0000000000000000000a1';
const SECTOR_ID = '64b0000000000000000000b2';

/**
 * Replace the Delivery client calls with deterministic answers: the tests must
 * not depend on another service being up, but they DO exercise the real shop
 * service (so an ownership/visibility regression still fails the suite).
 */
function stubDelivery() {
  deliveryClient.getLocation = async (id) => {
    if (id === LOCATION_ID) {
      return { status: 200, body: { location: { _id: id, name: 'Harar', type: 'city', isActive: true } } };
    }
    if (id === SECTOR_ID) {
      return { status: 200, body: { location: { _id: id, name: 'Sector 01', type: 'sector', isActive: true } } };
    }
    return { status: 404, body: {} };
  };
  deliveryClient.getLocationHierarchy = async () => ({
    status: 200,
    body: {
      hierarchy: [{
        _id: '64b0000000000000000000a0', name: 'Ethiopia', type: 'country',
        children: [{
          _id: '64b0000000000000000000a9', name: 'Hararghe', type: 'region',
          children: [{
            _id: LOCATION_ID, name: 'Harar', type: 'city',
            children: [{ _id: SECTOR_ID, name: 'Sector 01', type: 'sector', children: [] }],
          }],
        }],
      }],
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function shopDoc(overrides = {}) {
  return {
    name: 'Test Shop', email: 'shop@test.local', address: '1 Test Street',
    phoneNumber: 911000000, zipCode: 1000, ownerId: 'owner-1', status: 'APPROVED',
    avatar: { public_id: 'a', url: '/uploads/a.png' },
    showOnPublic: true,
    ...overrides,
  };
}

async function create(overrides = {}) {
  return Shop.create(shopDoc(overrides));
}

/** Minimal express req/res doubles for the validators. */
function runValidator(validator, body) {
  const req = { body };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  let nextCalled = false;
  validator(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, payload };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  await mongoose.connect(DB_URL);
  Shop = require('../models/Shops');
  Product = require('../../catalog/models/Products');
  // deleteMany + init (not dropDatabase): drop races parallel suite starts
  // (DatabaseDropPending) and index build mid-test causes "Shop not found" flakes.
  await Promise.all([Shop.deleteMany({}), Product.deleteMany({})]);
  await Promise.all([Shop.init(), Product.init()]);
  shopRepository = require('../repositories/shops.repository');
  shopService = require('../services/shops.service');
  deliveryClient = require('../../../app/clients/delivery.client').deliveryClient;
  validators = require('../../../shared/validators/commerce.validators');
});

beforeEach(async () => {
  // deleteMany, not dropDatabase: drop leaves the DB in DatabaseDropPending
  // under concurrent suite starts and fails the next hook. Clearing the two
  // collections this suite touches is enough and is atomic-fast.
  await Promise.all([
    mongoose.connection.db.collection('shops').deleteMany({}),
    mongoose.connection.db.collection('products').deleteMany({}),
  ]);
  stubDelivery();
});

// afterEach deleteMany (NOT dropDatabase): drop races parallel suite starts
// (DatabaseDropPending / Shop not found). Mirrors beforeEach so state never
// leaks from a finished test into the next suite's first assertion.
afterEach(async () => {
  await Promise.all([
    mongoose.connection.db.collection('shops').deleteMany({}),
    mongoose.connection.db.collection('products').deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.connection.close();
});


// ── Model ──────────────────────────────────────────────────────────────────
describe('Shop model', () => {
  it('defaults a new shop to PENDING_APPROVAL and to public-visible curation flags', async () => {
    const shop = await Shop.create({ name: 'S', email: 's@t.io', address: 'a', phoneNumber: 1, zipCode: 1, avatar: { public_id: 'x', url: 'u' }, ownerId: 'o1' });
    assert.strictEqual(shop.status, 'PENDING_APPROVAL');
    assert.strictEqual(shop.showOnPublic, true);
    assert.strictEqual(shop.featured, false);
  });

  it('rejects an unknown status', async () => {
    await assert.rejects(() => Shop.create(shopDoc({ status: 'DELETED' })), /status/);
  });

  it('requires an owner', async () => {
    const doc = shopDoc();
    delete doc.ownerId;
    await assert.rejects(() => Shop.create(doc), /ownerId/);
  });
});

// ── Creation ───────────────────────────────────────────────────────────────
describe('createShop', () => {
  it('derives the owner from the authenticated caller (body ownerId is ignored)', async () => {
    const shop = await shopService.createShop(
      {
        name: 'Second Shop', email: 'shop2@test.local', address: '2 Street',
        phoneNumber: '911111111', zipCode: '2000', avatar: { public_id: 'p', url: '/uploads/p.png' },
        ownerId: 'someone-else', businessId: 'other-business',
      },
      { id: 'owner-1', role: 'SELLER' }
    );
    assert.strictEqual(shop.ownerId, 'owner-1');
    assert.strictEqual(shop.status, 'PENDING_APPROVAL');
  });

  it('requires an authenticated caller', async () => {
    await assert.rejects(
      () => shopService.createShop({ name: 'X', email: 'x@t.io', address: 'a', phoneNumber: '1', avatar: { url: 'u' } }, null),
      (err) => err.statusCode === 401
    );
  });

  it('persists a VALIDATED location and builds the snapshot server-side', async () => {
    const shop = await shopService.createShop(
      {
        name: 'Located Shop', email: 'loc@test.local', address: '3 Street',
        phoneNumber: '911222333', avatar: { public_id: 'p', url: '/uploads/p.png' },
        locationId: LOCATION_ID, sectorId: SECTOR_ID,
        // A client-supplied snapshot must never win over the server-side one.
        locationSnapshot: { regionName: 'FAKE', resolvedAt: new Date() },
      },
      { id: 'owner-1', role: 'SELLER' }
    );
    assert.strictEqual(shop.locationId, LOCATION_ID);
    assert.strictEqual(shop.sectorId, SECTOR_ID);
    assert.strictEqual(shop.locationSnapshot.regionName, 'Hararghe');
    assert.strictEqual(shop.locationSnapshot.cityName, 'Harar');
    assert.strictEqual(shop.locationSnapshot.sectorName, 'Sector 01');
    assert.notStrictEqual(shop.locationSnapshot.regionName, 'FAKE');
  });

  it('rejects an unknown location id', async () => {
    await assert.rejects(
      () => shopService.createShop(
        {
          name: 'Bad Loc', email: 'bad@test.local', address: 'a', phoneNumber: '911222333',
          avatar: { public_id: 'p', url: '/uploads/p.png' },
          sectorId: '64b00000000000000000dead',
        },
        { id: 'owner-1', role: 'SELLER' }
      ),
      (err) => err.statusCode === 400 && /Unknown sectorId/.test(err.message)
    );
  });
});

// ── Ownership resolution (the write gate) ──────────────────────────────────
describe('resolveOwnedShop', () => {
  it('accepts an owned shop id and rejects another business shop', async () => {
    const mine = await create({ ownerId: 'owner-1' });
    const theirs = await create({ ownerId: 'owner-2' });

    const resolved = await shopService.resolveOwnedShop({ id: 'owner-1' }, String(mine._id));
    assert.strictEqual(String(resolved._id), String(mine._id));

    await assert.rejects(
      () => shopService.resolveOwnedShop({ id: 'owner-1' }, String(theirs._id)),
      (err) => err.statusCode === 403
    );
  });

  it('returns the single shop when shopId is omitted, and refuses to guess when there are several', async () => {
    const only = await create({ ownerId: 'owner-1' });
    const single = await shopService.resolveOwnedShop({ id: 'owner-1' });
    assert.strictEqual(String(single._id), String(only._id));

    await create({ ownerId: 'owner-1', name: 'Second' });
    await assert.rejects(
      () => shopService.resolveOwnedShop({ id: 'owner-1' }),
      (err) => err.statusCode === 400 && /shopId is required/.test(err.message)
    );
  });

  it('answers 404 for a caller that owns no shop', async () => {
    await assert.rejects(
      () => shopService.resolveOwnedShop({ id: 'nobody' }, null),
      (err) => err.statusCode === 404
    );
  });
});

// ── Read visibility (the cross-tenant read gate) ───────────────────────────
describe('getShopInfo visibility', () => {
  it('gives the OWNER and an ADMIN the full document', async () => {
    const shop = await create({ ownerId: 'owner-1' });

    const asOwner = await shopService.getShopInfo(String(shop._id), { id: 'owner-1', role: 'SELLER' });
    assert.strictEqual(asOwner.ownerId, 'owner-1');

    const asAdmin = await shopService.getShopInfo(String(shop._id), { id: 'admin-1', role: 'ADMIN' });
    assert.strictEqual(asAdmin.ownerId, 'owner-1');
    assert.ok('availableBalance' in asAdmin);
  });

  it('gives everyone else the public allowlist only — no owner, email, phone or balance', async () => {
    const shop = await create({ ownerId: 'owner-1' });
    const seen = await shopService.getShopInfo(String(shop._id), { id: 'someone-else', role: 'CUSTOMER' });

    assert.strictEqual(seen.name, 'Test Shop');
    assert.strictEqual(seen.ownerId, undefined);
    assert.strictEqual(seen.email, undefined);
    assert.strictEqual(seen.phoneNumber, undefined);
    assert.strictEqual(seen.availableBalance, undefined);
    assert.strictEqual(seen.transections, undefined);
    assert.strictEqual(seen.showOnPublic, undefined);
  });

  it('hides a PENDING, SUSPENDED or admin-hidden shop from a non-owner (404)', async () => {
    for (const overrides of [
      { status: 'PENDING_APPROVAL' },
      { status: 'SUSPENDED' },
      { status: 'APPROVED', showOnPublic: false },
    ]) {
      await mongoose.connection.db.collection('shops').deleteMany({});
      const shop = await create({ ownerId: 'owner-1', ...overrides });
      await assert.rejects(
        () => shopService.getShopInfo(String(shop._id), { id: 'someone-else', role: 'CUSTOMER' }),
        (err) => err.statusCode === 404
      );
    }
  });

  it('answers 404 for a malformed id instead of throwing a CastError', async () => {
    await assert.rejects(
      () => shopService.getShopInfo('not-an-object-id', { id: 'owner-1', role: 'SELLER' }),
      (err) => err.statusCode === 404
    );
  });
});

// ── Owner update allowlist ─────────────────────────────────────────────────
describe('updateInfo', () => {
  it('updates editable fields and ignores every server/admin-owned field', async () => {
    const shop = await create({ ownerId: 'owner-1' });
    const updated = await shopService.updateInfo(shop, {
      name: '  Renamed Shop  ',
      description: 'new description',
      status: 'ACTIVE',
      showOnPublic: false,
      ownerId: 'attacker',
      applicationId: 'attacker-app',
      availableBalance: 999999,
      locationSnapshot: { regionName: 'FAKE', resolvedAt: new Date() },
    });

    assert.strictEqual(updated.name, 'Renamed Shop');
    assert.strictEqual(updated.description, 'new description');
    assert.strictEqual(updated.status, 'APPROVED');
    assert.strictEqual(updated.showOnPublic, true);
    assert.strictEqual(updated.ownerId, 'owner-1');
    assert.strictEqual(updated.applicationId, undefined);
    assert.strictEqual(updated.availableBalance, 0);
    assert.notStrictEqual(updated.locationSnapshot.regionName, 'FAKE');
    assert.ok(updated.updatedAt instanceof Date);
  });

  it('rejects an unknown sector and leaves the shop untouched', async () => {
    const shop = await create({ ownerId: 'owner-1' });
    await assert.rejects(
      () => shopService.updateInfo(shop, { sectorId: '64b00000000000000000dead' }),
      (err) => err.statusCode === 400
    );
    const reloaded = await shopRepository.findById(String(shop._id));
    assert.strictEqual(reloaded.sectorId, undefined);
  });

  it('accepts a valid sector and resolves the snapshot from Delivery', async () => {
    const shop = await create({ ownerId: 'owner-1' });
    const updated = await shopService.updateInfo(shop, { sectorId: SECTOR_ID, locationId: LOCATION_ID });
    assert.strictEqual(updated.sectorId, SECTOR_ID);
    assert.strictEqual(updated.locationId, LOCATION_ID);
    assert.strictEqual(updated.locationSnapshot.sectorName, 'Sector 01');
  });
});

// ── Owner shop list ────────────────────────────────────────────────────────
describe('getSellerShops', () => {
  it('returns EVERY shop of the business with a real product count', async () => {
    const a = await create({ ownerId: 'owner-1', name: 'Shop A' });
    await create({ ownerId: 'owner-1', name: 'Shop B' });
    await create({ ownerId: 'owner-2', name: 'Other business' });

    await Product.create({
      name: 'Widget', description: 'a widget for testing', category: 'cat',
      discountPrice: 10, stock: 5, shopId: String(a._id), shop: { name: 'Shop A' },
    });

    const shops = await shopService.getSellerShops('owner-1');
    assert.strictEqual(shops.length, 2);
    assert.deepStrictEqual(shops.map((s) => s.name).sort(), ['Shop A', 'Shop B']);
    const counted = shops.find((s) => String(s._id) === String(a._id));
    assert.strictEqual(counted.productCount, 1);
  });
});


// ── Status lifecycle ──────────────────────────────────────────────────────
describe('updateShopStatus', () => {
  it('records approval metadata and cascades the status into product snapshots', async () => {
    const shop = await create({ ownerId: 'owner-1', status: 'PENDING_APPROVAL' });
    const product = await Product.create({
      name: 'Widget', description: 'a widget for testing', category: 'cat',
      discountPrice: 10, stock: 5, shopId: String(shop._id), shop: { status: 'PENDING_APPROVAL' },
    });

    const approved = await shopService.updateShopStatus(String(shop._id), 'APPROVED', 'admin-1');
    assert.strictEqual(approved.status, 'APPROVED');
    assert.strictEqual(approved.approvalMetadata.approvedBy, 'admin-1');
    assert.ok(approved.approvalMetadata.approvedAt instanceof Date);

    const reloadedProduct = await Product.findById(product._id);
    assert.strictEqual(reloadedProduct.shop.status, 'APPROVED');
  });

  it('records the reason for a rejection and for a suspension', async () => {
    const shop = await create({ ownerId: 'owner-1' });

    const rejected = await shopService.updateShopStatus(String(shop._id), 'INACTIVE', 'admin-1', { reason: 'bad documents' });
    assert.strictEqual(rejected.status, 'INACTIVE');
    assert.strictEqual(rejected.approvalMetadata.rejectionReason, 'bad documents');

    const suspended = await shopService.updateShopStatus(String(shop._id), 'SUSPENDED', 'admin-1', { reason: 'fraud review' });
    assert.strictEqual(suspended.status, 'SUSPENDED');
    assert.strictEqual(suspended.approvalMetadata.suspensionReason, 'fraud review');
    assert.strictEqual(suspended.approvalMetadata.suspendedBy, 'admin-1');
  });

  it('rejects an unknown status and a missing shop', async () => {
    const shop = await create({ ownerId: 'owner-1' });
    await assert.rejects(
      () => shopService.updateShopStatus(String(shop._id), 'DELETED', 'admin-1'),
      (err) => err.statusCode === 400
    );
    await assert.rejects(
      () => shopService.updateShopStatus('64b00000000000000000dead', 'APPROVED', 'admin-1'),
      (err) => err.statusCode === 404
    );
  });
});

// ── Validators ─────────────────────────────────────────────────────────────
describe('shop validators', () => {
  const validCreate = {
    name: 'Shop', email: 'shop@test.local', address: '1 Street',
    phoneNumber: '0911222333', zipCode: '1000',
  };

  it('validateCreateShop accepts a complete payload', () => {
    const result = runValidator(validators.validateCreateShop, { ...validCreate });
    assert.strictEqual(result.nextCalled, true);
  });

  it('validateCreateShop rejects missing name, email, address and phone', () => {
    const result = runValidator(validators.validateCreateShop, {});
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.payload.code, 'VALIDATION_ERROR');
    assert.ok(result.payload.errors.length >= 4);
  });

  it('validateCreateShop rejects a malformed email and a non-numeric phone', () => {
    const result = runValidator(validators.validateCreateShop, { ...validCreate, email: 'nope', phoneNumber: 'abc' });
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.payload.errors.length >= 2, true);
  });

  it('validateUpdateShop accepts a partial update and rejects bad values', () => {
    assert.strictEqual(runValidator(validators.validateUpdateShop, { name: 'New name' }).nextCalled, true);
    assert.strictEqual(runValidator(validators.validateUpdateShop, {}).nextCalled, true);

    const badEmail = runValidator(validators.validateUpdateShop, { email: 'nope' });
    assert.strictEqual(badEmail.nextCalled, false);
    assert.strictEqual(badEmail.statusCode, 400);

    const badLocation = runValidator(validators.validateUpdateShop, { sectorId: 123 });
    assert.strictEqual(badLocation.nextCalled, false);
  });

  it('validateUpdateShop does not accept empty required-ish values', () => {
    const result = runValidator(validators.validateUpdateShop, { name: 'x' });
    assert.strictEqual(result.nextCalled, false);
  });
});

