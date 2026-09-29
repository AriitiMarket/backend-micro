#!/usr/bin/env node
/**
 * Product-module bug hunt — probes for defects the flow harnesses do not cover,
 * driven against the LIVE commerce-service.
 *
 * Each check documents the intended contract; failures here were real defects
 * (these probes were written to fail against the pre-fix build).
 *
 *   BH-1 mass assignment on create (seller-injected reviews/ratings/sold_out/…)
 *   BH-2 mass assignment on update (status / isActive / reserved / shop / …)
 *   BH-3 clearing an optional text field (sku, tags) on update
 *   BH-4 category validation (wrong type, unknown title, inactive)
 *   BH-5 image URL sanitisation (javascript:, relative, data:)
 *   BH-6 malformed pagination and absurd limits
 *   BH-7 lifecycle edge cases (publish an archived row, legacy drafts)
 *
 * Usage:
 *   docker exec <commerce-container> node scripts/pm-e2e-bughunt.js
 */
const mongoose = require('mongoose');
const lib = require('./pm-e2e-lib');

const { api, check, fixtures, MODELS, SELLER_A, ADMIN, CUSTOMER } = lib;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/ariti_commerce';
const { Product, StockMovement } = MODELS;

let SHOP_A_ID = null;
const payload = (over = {}) => ({
  name: 'PMBH Probe Widget',
  description: 'Bug-hunt probe product; safe to delete.',
  category: 'E2E Cat',
  discountPrice: 50,
  originalPrice: 60,
  stock: 10,
  tags: 'pmbhprobe',
  shopId: SHOP_A_ID,
  ...over,
});

const productsOf = (res) => ((res.body || {}).products || []);

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const { shopA } = await fixtures();
  SHOP_A_ID = String(shopA._id);

  try {
    // ── [1] BH-1 mass assignment on create ──────────────────────────────────
    console.log('\n[1] BH-1 - create must ignore server-owned fields');
    const forged = await api('POST', '/product/create-product', {
      as: SELLER_A,
      body: payload({
        name: 'PMBH Forged Widget',
        sku: 'PMBH-1',
        // Everything below is SERVER-OWNED: a seller may never set it.
        status: 'PUBLISHED',
        isActive: false,
        reserved: 999,
        sold_out: 4242,
        ratings: 5,
        reviews: [{
          user: { _id: 'pmbh_fake', name: 'Fake Reviewer' },
          rating: 5,
          comment: 'INJECTED APPROVED REVIEW',
          moderationStatus: 'approved',
        }],
        publishedAt: '2000-01-01T00:00:00.000Z',
        createdAt: '2000-01-01T00:00:00.000Z',
        categoryId: 'deadbeefdeadbeefdeadbeef',
      }),
    });
    check('forged create returns 201', forged.status === 201, forged.body);
    const forgedProduct = (forged.body || {}).product || {};
    const forgedId = forgedProduct._id;

    check('BH-1 status is forced to DRAFT (not client-sent PUBLISHED)',
      forgedProduct.status === 'DRAFT', forgedProduct.status);
    check('BH-1 isActive is not client-settable',
      forgedProduct.isActive === true, forgedProduct.isActive);
    check('BH-1 reserved is not client-settable (0)',
      !forgedProduct.reserved, forgedProduct.reserved);
    check('BH-1 sold_out is not client-settable (0)',
      !forgedProduct.sold_out, forgedProduct.sold_out);
    check('BH-1 ratings is not client-settable',
      !forgedProduct.ratings, forgedProduct.ratings);
    check('BH-1 injected reviews are rejected',
      !(forgedProduct.reviews || []).length, (forgedProduct.reviews || []).length);
    check('BH-1 categoryId is resolved server-side (not the forged value)',
      forgedProduct.categoryId !== 'deadbeefdeadbeefdeadbeef', forgedProduct.categoryId);
    const forgedStored = await Product.findById(forgedId).lean();
    check('BH-1 no approved review reached the database',
      !(forgedStored.reviews || []).some((r) => r.moderationStatus === 'approved'),
      (forgedStored.reviews || []).map((r) => r.moderationStatus));
    check('BH-1 publishedAt was not client-set', !forgedStored.publishedAt, forgedStored.publishedAt);
    check('BH-1 forged product is not public',
      (await api('GET', `/product/public/${forgedId}`)).status === 404);

    // ── [2] BH-2 mass assignment on update ──────────────────────────────────
    console.log('\n[2] BH-2 - update must ignore server-owned fields');
    const upd = await api('PUT', `/product/update-product/${forgedId}`, {
      as: SELLER_A,
      body: {
        name: 'PMBH Forged Widget v2',
        status: 'PUBLISHED',
        isActive: false,
        reserved: 77,
        sold_out: 999,
        ratings: 2.5,
        publishedAt: '2001-01-01T00:00:00.000Z',
        archivedAt: '2001-01-01T00:00:00.000Z',
        shop: { name: 'Hijacked', ownerId: 'pmbh_attacker', availableBalance: 1000000 },
        sellerId: 'pmbh_attacker',
        shopId: 'deadbeefdeadbeefdeadbeef',
        categoryId: 'deadbeefdeadbeefdeadbeef',
        reviews: [{ user: { _id: 'pmbh_fake' }, rating: 1, comment: 'INJECTED', moderationStatus: 'approved' }],
      },
    });
    check('update with forged fields returns 200', upd.status === 200, upd.body);
    const afterUpd = await Product.findById(forgedId).lean();
    check('BH-2 status unchanged by update', afterUpd.status === 'DRAFT', afterUpd.status);
    check('BH-2 isActive unchanged by update', afterUpd.isActive === true, afterUpd.isActive);
    check('BH-2 reserved unchanged by update', !afterUpd.reserved, afterUpd.reserved);
    check('BH-2 sold_out unchanged by update', !afterUpd.sold_out, afterUpd.sold_out);
    check('BH-2 ratings unchanged by update', !afterUpd.ratings, afterUpd.ratings);
    check('BH-2 publishedAt unchanged by update', !afterUpd.publishedAt, afterUpd.publishedAt);
    check('BH-2 archivedAt unchanged by update', !afterUpd.archivedAt, afterUpd.archivedAt);
    check('BH-2 embedded shop snapshot not hijacked',
      Boolean(afterUpd.shop) && afterUpd.shop.ownerId !== 'pmbh_attacker',
      afterUpd.shop && afterUpd.shop.name);
    check('BH-2 sellerId not hijacked', afterUpd.sellerId !== 'pmbh_attacker', afterUpd.sellerId);
    check('BH-2 shopId not hijacked', afterUpd.shopId === SHOP_A_ID, afterUpd.shopId);
    check('BH-2 categoryId not client-set',
      afterUpd.categoryId !== 'deadbeefdeadbeefdeadbeef', afterUpd.categoryId);
    check('BH-2 reviews not injected', !(afterUpd.reviews || []).length,
      (afterUpd.reviews || []).length);
    check('BH-2 the editable field DID change (control)',
      afterUpd.name === 'PMBH Forged Widget v2', afterUpd.name);

    // ── [3] BH-3 clearing an optional text field ────────────────────────────
    console.log('\n[3] BH-3 - optional text fields can be cleared');
    const clear = await api('PUT', `/product/update-product/${forgedId}`, {
      as: SELLER_A, body: { sku: '', tags: '' },
    });
    check('clearing sku/tags returns 200', clear.status === 200, clear.body);
    const cleared = await Product.findById(forgedId).lean();
    check('BH-3 sku can be cleared to empty', cleared.sku === '', JSON.stringify(cleared.sku));
    check('BH-3 tags can be cleared to empty', !cleared.tags, JSON.stringify(cleared.tags));
    check('BH-3 an empty sku never blocks a new product using that sku',
      (await api('POST', '/product/create-product', {
        as: SELLER_A, body: payload({ name: 'PMBH Reuse Sku', sku: 'PMBH-1' }),
      })).status === 201);
    check('BH-3 a NON-empty sku is still protected', (await api('PUT', `/product/update-product/${forgedId}`, {
      as: SELLER_A, body: { sku: 'PMBH-1' },
    })).status === 409);

    // ── [4] BH-4 category validation ────────────────────────────────────────
    console.log('\n[4] BH-4 - category validation (title-as-FK)');
    const unknownCat = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PMBH Unknown Cat', category: 'No Such Category' }),
    });
    check('BH-4 unknown category -> 400', unknownCat.status === 400, unknownCat.body);
    const wrongTypeCat = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PMBH Wrong Type Cat', category: 'PM-E2E Inactive Cat' }),
    });
    check('BH-4 inactive category -> 400', wrongTypeCat.status === 400, wrongTypeCat.body);
    const updateUnknownCat = await api('PUT', `/product/update-product/${forgedId}`, {
      as: SELLER_A, body: { category: 'No Such Category' },
    });
    check('BH-4 update to an unknown category -> 400', updateUnknownCat.status === 400,
      updateUnknownCat.body);
    const updateInactiveCat = await api('PUT', `/product/update-product/${forgedId}`, {
      as: SELLER_A, body: { category: 'PM-E2E Inactive Cat' },
    });
    check('BH-4 update into an inactive category -> 400', updateInactiveCat.status === 400,
      updateInactiveCat.body);
    check('BH-4 the product kept its original category',
      (await Product.findById(forgedId).lean()).category === 'E2E Cat');

    // ── [5] BH-5 image URL sanitisation ─────────────────────────────────────
    console.log('\n[5] BH-5 - image references are sanitised');
    const imgRes = await api('POST', '/product/create-product', {
      as: SELLER_A,
      body: payload({
        name: 'PMBH Image Widget',
        imageUrls: 'javascript:alert(1), https://ok.example/pmbh.png, /relative/pmbh.png, data:image/png;base64,PMBH',
      }),
    });
    check('product with image URLs created', imgRes.status === 201, imgRes.body);
    const imgProduct = (imgRes.body || {}).product || {};
    const storedImages = imgProduct.images || [];
    check('BH-5 https image kept',
      storedImages.includes('https://ok.example/pmbh.png'), storedImages);
    check('BH-5 inline data:image kept (renders without a host)',
      storedImages.some((u) => String(u).startsWith('data:image/')), storedImages);
    check('BH-5 javascript: URI dropped',
      !storedImages.some((u) => /^javascript:/i.test(String(u))), storedImages);
    check('BH-5 relative path dropped',
      !storedImages.some((u) => String(u).startsWith('/')), storedImages);

    // ── [6] BH-6 malformed pagination and absurd limits ──────────────────────
    console.log('\n[6] BH-6 - pagination/limit inputs are clamped');
    const junkSearch = await api('GET', '/product/search?q=PMBH&page=abc&limit=xyz');
    check('BH-6 malformed search pagination falls back to defaults',
      junkSearch.status === 200 && junkSearch.body.page === 1 && junkSearch.body.limit === 50,
      { page: junkSearch.body && junkSearch.body.page, limit: junkSearch.body && junkSearch.body.limit });

    const hugeList = await api('GET', '/product/get-all-products?limit=99999', { as: CUSTOMER });
    check('BH-6 huge list limit is capped at 200',
      hugeList.status === 200 && hugeList.body.limit <= 200, hugeList.body && hugeList.body.limit);

    const zeroPublic = await api('GET', '/product/public/all?limit=0');
    check('BH-6 public limit=0 never returns an empty page silently',
      zeroPublic.status === 200 && zeroPublic.body.limit >= 1 && productsOf(zeroPublic).length >= 1,
      { limit: zeroPublic.body && zeroPublic.body.limit, rows: productsOf(zeroPublic).length });

    const negativePage = await api('GET', '/product/public/all?page=-5');
    check('BH-6 negative public page is clamped to 1',
      negativePage.status === 200 && negativePage.body.page === 1, negativePage.body && negativePage.body.page);

    const zeroSearch = await api('GET', '/product/search?limit=0');
    check('BH-6 search limit=0 falls back to the default page size',
      zeroSearch.status === 200 && zeroSearch.body.limit >= 1, zeroSearch.body && zeroSearch.body.limit);

    // ── [7] BH-7 lifecycle edge cases ───────────────────────────────────────
    console.log('\n[7] BH-7 - lifecycle transitions cannot be shortcut');
    const reuse = await Product.findOne({ sku: 'PMBH-1' }).lean();
    const reuseId = String(reuse._id);

    const archiveDraft = await api('POST', `/product/archive/${reuseId}`, { as: SELLER_A });
    check('BH-7 archiving a DRAFT works', archiveDraft.status === 200
      && archiveDraft.body.product.status === 'ARCHIVED', archiveDraft.body);

    const publishArchived = await api('POST', `/product/publish/${reuseId}`, { as: SELLER_A });
    check('BH-7 publishing an ARCHIVED product does not silently publish it',
      publishArchived.status === 200 && publishArchived.body.product.status !== 'PUBLISHED',
      publishArchived.body && publishArchived.body.product && publishArchived.body.product.status);
    check('BH-7 the archived product is still not public',
      (await api('GET', `/product/public/${reuseId}`)).status === 404);

    const restore = await api('POST', `/product/unarchive/${reuseId}`, { as: SELLER_A });
    check('BH-7 restore returns DRAFT', restore.status === 200
      && restore.body.product.status === 'DRAFT', restore.body);

    const publishRestored = await api('POST', `/product/publish/${reuseId}`, { as: SELLER_A });
    check('BH-7 a restored product publishes', publishRestored.status === 200
      && publishRestored.body.product.status === 'PUBLISHED', publishRestored.body);

    const unarchiveLive = await api('POST', `/product/unarchive/${reuseId}`, { as: SELLER_A });
    check('BH-7 unarchiving a LIVE product never demotes it to DRAFT',
      unarchiveLive.status === 200 && unarchiveLive.body.product.status === 'PUBLISHED',
      unarchiveLive.body && unarchiveLive.body.product && unarchiveLive.body.product.status);

    check('BH-7 drafting an already-drafted product is an idempotent 200',
      (await api('POST', `/product/draft/${reuseId}`, { as: SELLER_A })).status === 200
        && (await api('POST', `/product/draft/${reuseId}`, { as: SELLER_A })).status === 200);

    check('BH-7 a returned-to-draft product stays editable (restore-then-fix flow)',
      (await api('PUT', `/product/update-product/${reuseId}`, { as: SELLER_A, body: { stock: 3 } })).status === 200);

    // ── [8] BH-8 numeric fields the request validator never checked ─────────
    console.log('\n[8] BH-8 - create validates every numeric field');
    const negativeThreshold = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PMBH Bad Threshold', lowStockThreshold: -5 }),
    });
    check('BH-8 negative lowStockThreshold on create -> 400',
      negativeThreshold.status === 400, negativeThreshold.body);
    const junkThreshold = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PMBH Junk Threshold', lowStockThreshold: 'abc' }),
    });
    check('BH-8 non-numeric lowStockThreshold on create -> 400',
      junkThreshold.status === 400, junkThreshold.body);
    const negativeListPrice = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PMBH Neg List', originalPrice: -10 }),
    });
    check('BH-8 negative originalPrice on create -> 400',
      negativeListPrice.status === 400, negativeListPrice.body);
    const coerced = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PMBH Coerced Numbers', stock: '7', discountPrice: '12.5', lowStockThreshold: '2' }),
    });
    check('BH-8 numeric strings are coerced, not rejected',
      coerced.status === 201
        && coerced.body.product.stock === 7
        && coerced.body.product.discountPrice === 12.5
        && coerced.body.product.lowStockThreshold === 2,
      coerced.body && coerced.body.product);

    // ── [9] BH-9 gallery replace / clear / policy ───────────────────────────
    console.log('\n[9] BH-9 - the gallery can be edited without losing stored files');
    const gallery = await Product.findOne({ sku: 'PMBH-1' }).lean();
    const galleryId = String(gallery._id);
    // Simulate a product whose gallery holds a file THIS service stored
    // (local mode writes `/uploads/<name>`) plus a remote image.
    await Product.updateOne(
      { _id: galleryId },
      { $set: { images: ['/uploads/pmbh-local.jpg', 'https://x.example/keep.png'] } }
    );

    const replaced = await api('PUT', `/product/update-product/${galleryId}`, {
      as: SELLER_A,
      body: {
        imageUrls: '/uploads/pmbh-local.jpg, https://x.example/keep.png, javascript:alert(1), https://x.example/new.png',
        keepExistingImages: 'false',
      },
    });
    check('replace with a raw list returns 200', replaced.status === 200, replaced.body);
    const replacedDoc = await Product.findById(galleryId).lean();
    check('BH-9 a locally stored /uploads/… image survives a replacement',
      (replacedDoc.images || []).includes('/uploads/pmbh-local.jpg'), replacedDoc.images);
    check('BH-9 the existing remote image survives a replacement',
      (replacedDoc.images || []).includes('https://x.example/keep.png'), replacedDoc.images);
    check('BH-9 a new valid URL is added',
      (replacedDoc.images || []).includes('https://x.example/new.png'), replacedDoc.images);
    check('BH-9 a javascript: URI can never enter the gallery (update path)',
      !(replacedDoc.images || []).some((src) => /^javascript:/i.test(String(src))), replacedDoc.images);

    const clearRes = await api('PUT', `/product/update-product/${galleryId}`, {
      as: SELLER_A, body: { clearImages: 'true' },
    });
    check('clearImages empties the gallery', clearRes.status === 200
      && Array.isArray(clearRes.body.product.images)
      && clearRes.body.product.images.length === 0,
      clearRes.body && clearRes.body.product && clearRes.body.product.images);

    const untouched = await api('PUT', `/product/update-product/${galleryId}`, {
      as: SELLER_A, body: { name: 'PMBH Forged Widget v3' },
    });
    check('BH-9 a normal edit without image fields leaves the gallery alone',
      untouched.status === 200 && (untouched.body.product.images || []).length === 0,
      untouched.body && untouched.body.product && untouched.body.product.images);

    // ── [10] BH-10/11/12 - shop gate, snapshot sync, shop mass assignment ───
    console.log('\n[10] BH-10/11/12 - shop status gate + snapshot sync + shop update allowlist');
    const gateRes = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2BH Gate Widget', sku: 'PMBH-G1' }),
    });
    const gateProduct = (gateRes.body || {}).product;
    const gateId = gateProduct && gateProduct._id;
    check('gate fixture created', Boolean(gateId), gateRes.body);
    await api('POST', `/product/publish/${gateId}`, { as: SELLER_A });
    check('control: the product is public while its shop is approved',
      (await api('GET', `/product/public/${gateId}`)).status === 200);

    // BH-12: the seller may only edit profile fields — never the gate fields.
    const originalShop = await MODELS.Shop.findById(SHOP_A_ID).lean();
    const hijack = await api('PUT', '/shop/update-shop-info', {
      as: SELLER_A,
      body: {
        name: 'PM2BH Renamed Shop',
        status: 'INACTIVE',
        ownerId: 'pmbh_attacker',
        showOnPublic: false,
        role: 'Admin',
        applicationId: 'pmbh_app',
      },
    });
    check('BH-12 the legitimate profile change is accepted', hijack.status === 200, hijack.body);
    const shopRow = await MODELS.Shop.findById(SHOP_A_ID).lean();
    check('BH-12 the new name is applied', shopRow.name === 'PM2BH Renamed Shop', shopRow.name);
    check('BH-12 status cannot be self-assigned', shopRow.status === originalShop.status,
      shopRow.status);
    check('BH-12 ownerId cannot be hijacked', shopRow.ownerId === originalShop.ownerId,
      shopRow.ownerId);
    check('BH-12 showOnPublic cannot be un-hidden by the seller',
      shopRow.showOnPublic !== false, shopRow.showOnPublic);
    check('BH-12 role cannot be escalated', shopRow.role === 'Seller', shopRow.role);

    // BH-11: the rename followed through to the embedded snapshot.
    const gateDoc = await Product.findById(gateId).lean();
    check('BH-11 the rename cascaded into the embedded shop snapshot',
      Boolean(gateDoc.shop) && gateDoc.shop.name === 'PM2BH Renamed Shop',
      gateDoc.shop && gateDoc.shop.name);

    // BH-10: a rejected (inactive) seller must stop selling immediately.
    const rejectRes = await api('POST', `/shop/admin/shops/${SHOP_A_ID}/reject`, { as: ADMIN });
    check('admin can reject the shop', rejectRes.status === 200, rejectRes.body);
    const rejectedSnap = await Product.findById(gateId).lean();
    check('BH-10 the status change cascaded into the snapshot',
      rejectedSnap.shop && rejectedSnap.shop.status === 'INACTIVE',
      rejectedSnap.shop && rejectedSnap.shop.status);
    check('BH-10 its product 404s publicly while the shop is rejected',
      (await api('GET', `/product/public/${gateId}`)).status === 404);
    const rejectedSearch = await api('GET', `/product/search?q=${encodeURIComponent('PM2BH Gate Widget')}`);
    check('BH-10 ... and is absent from public search',
      !productsOf(rejectedSearch).some((p) => p._id === gateId), productsOf(rejectedSearch).length);
    const ownerStillSees = await api('GET', `/product/get-all-products-shop/${SHOP_A_ID}?includeInactive=true`, { as: SELLER_A });
    check('BH-10 the seller still sees it (to fix or appeal)',
      productsOf(ownerStillSees).some((p) => p._id === gateId));

    const approveRes = await api('POST', `/shop/admin/shops/${SHOP_A_ID}/approve`, { as: ADMIN });
    check('admin can re-approve the shop', approveRes.status === 200, approveRes.body);
    check('BH-10 re-approving restores public visibility',
      (await api('GET', `/product/public/${gateId}`)).status === 200);

    // Restore the fixture so the next harness run starts from a clean shop.
    await MODELS.Shop.updateOne(
      { _id: SHOP_A_ID },
      { $set: { name: originalShop.name, ownerId: originalShop.ownerId, status: originalShop.status,
        showOnPublic: originalShop.showOnPublic, role: originalShop.role } }
    );
    await MODELS.Product.updateMany(
      { shopId: SHOP_A_ID },
      { $set: { 'shop.name': originalShop.name, 'shop.status': originalShop.status,
        'shop.showOnPublic': originalShop.showOnPublic, 'shop.ownerId': originalShop.ownerId } }
    );

  } finally {
    // Probe fixtures always go, even when a check throws.
    try {
      await Product.deleteMany({
        $or: [{ tags: 'pmbhprobe' }, { name: { $regex: '^PMBH' } }, { sku: { $regex: '^PMBH-' } }],
      });
      await StockMovement.deleteMany({ shopId: SHOP_A_ID });
    } catch (e) { console.error('[cleanup] fixture deletion failed:', e.message); }
  }

  const { pass, fail, failures } = lib.summary();
  console.log(`\n=== Bug-hunt probes: ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});


