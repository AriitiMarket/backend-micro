#!/usr/bin/env node
/**
 * Phase-2 verification probes — one section per audit finding, driven against
 * the LIVE commerce-service over HTTP and asserted against the database.
 *
 * Covers:
 *   PM-001 public search no longer leaks DRAFT / deactivated / archived products
 *   PM-002 reserved-stock guard on BOTH adjust-stock and update-product
 *   PM-004 /get-all-products paginates for every signed-in caller
 *   PM-005 search is DB-side, bounded and reports total/page/totalPages
 *   PM-006 SKUs are unique per shop (clear 409 + partial unique index)
 *   PM-007 settings limits (maxImagesPerProduct / maxProductsPerSeller) enforced
 *   PM-009 public payloads expose derived `available`, never `reserved`
 *   PM-010 invalid shop id -> clean 400
 *   PM-012 image merging de-duplicates
 *   archive / unarchive lifecycle (reversible retirement, seller-owned)
 *
 * Usage:
 *   docker exec <commerce-container> node scripts/pm-e2e-phase2.js
 */
const mongoose = require('mongoose');
const lib = require('./pm-e2e-lib');

const { api, check, fixtures, MODELS, SELLER_A, SELLER_B, ADMIN, CUSTOMER } = lib;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/ariti_commerce';

const { Product, StockMovement } = MODELS;
// Loading the repository registers the `Settings` model with mongoose.
require('../src/modules/settings/repositories/settings.repository');
const Settings = mongoose.model('Settings');

const IMG1 = 'https://img.example/pm2-1.png';
const IMG2 = 'https://img.example/pm2-2.png';
const IMG3 = 'https://img.example/pm2-3.png';
const IMG4 = 'https://img.example/pm2-4.png';

/** Set once fixtures() has resolved the shop id the probes create into. */
let SHOP_A_ID = null;

/** Base payload for a valid product create (validators: name/desc/category/price/stock). */
const payload = (over = {}) => ({
  name: 'PM2 Probe Widget',
  description: 'Phase-2 verification probe product; safe to delete.',
  category: 'E2E Cat',
  discountPrice: 50,
  originalPrice: 60,
  stock: 10,
  tags: 'pm2probe',
  shopId: SHOP_A_ID,
  ...over,
});

const productsOf = (res) => ((res.body || {}).products || []);
const has = (res, id) => productsOf(res).some((p) => p._id === id);
const search = (q, qs = '') => api('GET', `/product/search?q=${encodeURIComponent(q)}${qs}`);

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const { shopA, shopB } = await fixtures();
  const shopAId = String(shopA._id);
  const shopBId = String(shopB._id);
  SHOP_A_ID = shopAId;
  let settingsBefore = null;

  try {
    console.log('\n[1] PM-006 - SKUs are unique per shop');
    const p1Res = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 Reserved Widget', sku: 'PM2-SKU-001' }),
    });
    check('create with a free SKU -> 201', p1Res.status === 201, p1Res.body);
    const p1 = p1Res.body && p1Res.body.product;
    const p1id = p1 && p1._id;

    const dupRes = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 Duplicate SKU Widget', sku: 'PM2-SKU-001' }),
    });
    check('PM-006 duplicate SKU on create -> 409', dupRes.status === 409, dupRes.status);

    const p2Res = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 Second Widget', sku: 'PM2-SKU-002' }),
    });
    check('create with a distinct SKU -> 201', p2Res.status === 201, p2Res.body);
    const p2id = p2Res.body && p2Res.body.product && p2Res.body.product._id;

    const updClash = await api('PUT', `/product/update-product/${p2id}`, {
      as: SELLER_A, body: { sku: 'PM2-SKU-001' },
    });
    check('PM-006 duplicate SKU on update -> 409', updClash.status === 409, updClash.status);

    const selfRes = await api('PUT', `/product/update-product/${p1id}`, {
      as: SELLER_A, body: { sku: 'PM2-SKU-001' },
    });
    check('PM-006 re-saving a product own sku -> 200 (no self-collision)',
      selfRes.status === 200, selfRes.status);

    const trimmed = await api('PUT', `/product/update-product/${p2id}`, {
      as: SELLER_A, body: { sku: '  PM2-SKU-002  ' },
    });
    check('PM-006 sku is trimmed on write',
      trimmed.status === 200 && trimmed.body.product.sku === 'PM2-SKU-002',
      trimmed.body && trimmed.body.product && trimmed.body.product.sku);

    const indexes = await Product.collection.indexes();
    const skuIndex = indexes.find((i) => i.name === 'uniq_shop_sku');
    check('PM-006 partial unique index uniq_shop_sku exists',
      Boolean(skuIndex && skuIndex.unique && skuIndex.partialFilterExpression), skuIndex);

    // ── [2] PM-009 (derived availability) + PM-002 (reserved guard) ──────────
    console.log('\n[2] PM-009 / PM-002 - availability + reserved-stock guard');
    await api('POST', `/product/publish/${p1id}`, { as: SELLER_A });
    await Product.updateOne({ _id: p1id }, { $set: { reserved: 3 } });

    const detail = await api('GET', `/product/public/${p1id}`);
    check('PM-009 public detail exposes derived available = stock - reserved',
      detail.status === 200 && detail.body.product.available === 7,
      detail.body && detail.body.product && detail.body.product.available);
    check('PM-009 public detail never exposes the reserved counter',
      detail.status === 200 && detail.body.product.reserved === undefined,
      detail.body && detail.body.product && detail.body.product.reserved);

    const pubList = await api('GET', '/product/public/all?limit=100');
    const row = productsOf(pubList).find((p) => p._id === p1id);
    check('PM-009 public list exposes available', Boolean(row) && row.available === 7, row && row.available);
    check('PM-009 public list never exposes reserved', Boolean(row) && row.reserved === undefined, row);

    const belowReserved = await api('PUT', `/product/adjust-stock/${p1id}`, {
      as: SELLER_A, body: { quantity: 1 },
    });
    check('PM-002 adjust-stock below reserved -> 400', belowReserved.status === 400, belowReserved.body);
    check('PM-002 guard message names the reserved units',
      /reserved/i.test((belowReserved.body || {}).message || ''), belowReserved.body);

    const negative = await api('PUT', `/product/adjust-stock/${p1id}`, {
      as: SELLER_A, body: { quantity: -5 },
    });
    check('adjust-stock negative -> 400', negative.status === 400, negative.status);

    const nonNumeric = await api('PUT', `/product/adjust-stock/${p1id}`, {
      as: SELLER_A, body: { quantity: 'abc' },
    });
    check('adjust-stock non-numeric -> 400', nonNumeric.status === 400, nonNumeric.status);

    const goodAdjust = await api('PUT', `/product/adjust-stock/${p1id}`, {
      as: SELLER_A, body: { quantity: 5 },
    });
    check('adjust-stock at/above reserved -> 200 (stock = 5)',
      goodAdjust.status === 200 && goodAdjust.body.product.stock === 5,
      goodAdjust.body && goodAdjust.body.product && goodAdjust.body.product.stock);

    const updBelow = await api('PUT', `/product/update-product/${p1id}`, {
      as: SELLER_A, body: { stock: 2 },
    });
    check('PM-002 update-product stock below reserved -> 400', updBelow.status === 400, updBelow.body);

    const updOk = await api('PUT', `/product/update-product/${p1id}`, {
      as: SELLER_A, body: { stock: 12 },
    });
    check('PM-002 update-product stock above reserved -> 200 (stock = 12)',
      updOk.status === 200 && updOk.body.product.stock === 12,
      updOk.body && updOk.body.product && updOk.body.product.stock);

    await Product.updateOne({ _id: p1id }, { $set: { reserved: 0 } });

    // ── [3] Archive / unarchive lifecycle ────────────────────────────────────
    console.log('\n[3] Archive / unarchive (reversible retirement)');
    const archived = await api('POST', `/product/archive/${p1id}`, { as: SELLER_A });
    check('archive -> 200 with status ARCHIVED',
      archived.status === 200 && archived.body.product.status === 'ARCHIVED',
      archived.body && archived.body.product && archived.body.product.status);
    check('archive stamps archivedAt',
      Boolean(archived.body.product && archived.body.product.archivedAt));

    const again = await api('POST', `/product/archive/${p1id}`, { as: SELLER_A });
    check('archive is idempotent -> 200 still ARCHIVED',
      again.status === 200 && again.body.product.status === 'ARCHIVED', again.status);

    check('archived product 404s on public detail',
      (await api('GET', `/product/public/${p1id}`)).status === 404);
    check('archived product absent from public list',
      !has(await api('GET', '/product/public/all?limit=100'), p1id));
    check('archived product absent from public search', !has(await search('PM2 Reserved Widget'), p1id));

    const ownerView = await api('GET', `/product/get-all-products-shop/${shopAId}?includeInactive=true`, { as: SELLER_A });
    check('owner still sees the archived product in their list', has(ownerView, p1id));

    const adminFilter = await api('GET', `/product/get-all-products?status=ARCHIVED&search=${encodeURIComponent('PM2 Reserved Widget')}`, { as: ADMIN });
    check('admin console can filter status=ARCHIVED', has(adminFilter, p1id), adminFilter.body && adminFilter.body.total);

    const foreign = await api('POST', `/product/archive/${p1id}`, { as: SELLER_B });
    check("another seller cannot archive it -> 403", foreign.status === 403, foreign.status);

    const restored = await api('POST', `/product/unarchive/${p1id}`, { as: SELLER_A });
    check('unarchive -> 200 and back to DRAFT',
      restored.status === 200 && restored.body.product.status === 'DRAFT',
      restored.body && restored.body.product && restored.body.product.status);
    check('unarchive clears archivedAt',
      Boolean(restored.body.product && !restored.body.product.archivedAt));
    check('restored product is still NOT public (DRAFT)',
      !has(await search('PM2 Reserved Widget'), p1id));

    const republished = await api('POST', `/product/publish/${p1id}`, { as: SELLER_A });
    check('a restored product can be published again',
      republished.status === 200 && republished.body.product.status === 'PUBLISHED');
    check('published again -> visible in public search', has(await search('PM2 Reserved Widget'), p1id));

    const badArchiveId = await api('POST', '/product/archive/not-a-valid-id', { as: SELLER_A });
    check('archive with a malformed id -> 400 (not 500)', badArchiveId.status === 400, badArchiveId.status);
    const missingArchiveId = await api('POST', '/product/archive/64b000000000000000000000', { as: SELLER_A });
    check('archive of an unknown id -> 404', missingArchiveId.status === 404, missingArchiveId.status);

    // ── [4] PM-001 - public search no longer leaks non-published products ────
    console.log('\n[4] PM-001 - public search visibility gates');
    const leakRes = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 LeakMarker Widget', sku: 'PM2-SKU-004' }),
    });
    const leakId = leakRes.body && leakRes.body.product && leakRes.body.product._id;
    check('leak-marker fixture created', Boolean(leakId), leakRes.body);

    check('PM-001 DRAFT absent from public search', !has(await search('LeakMarker'), leakId));
    check('PM-001 DRAFT 404s on public detail',
      (await api('GET', `/product/public/${leakId}`)).status === 404);
    check('PM-001 DRAFT absent from public list',
      !has(await api('GET', '/product/public/all?limit=100'), leakId));

    await api('POST', `/product/publish/${leakId}`, { as: SELLER_A });
    check('published product IS found by public search', has(await search('LeakMarker'), leakId));

    await api('POST', '/product/bulk', { as: ADMIN, body: { productIds: [leakId], action: 'deactivate' } });
    check('PM-001 deactivated product absent from public search', !has(await search('LeakMarker'), leakId));
    check('PM-001 deactivated product 404s on public detail',
      (await api('GET', `/product/public/${leakId}`)).status === 404);

    await api('POST', '/product/bulk', { as: ADMIN, body: { productIds: [leakId], action: 'activate' } });
    check('reactivated product found again', has(await search('LeakMarker'), leakId));

    await api('POST', `/product/draft/${leakId}`, { as: SELLER_A });
    check('PM-001 product re-drafted absent from public search again',
      !has(await search('LeakMarker'), leakId));

    const leakPage = await api('GET', `/product/search?q=LeakMarker&limit=1`);
    check('PM-001 gated result is bounded (limit=1)', leakPage.body && leakPage.body.limit === 1,
      leakPage.body && leakPage.body.limit);

    // ── [5] PM-004 - /get-all-products paginates for every caller ───────────
    console.log('\n[5] PM-004 - list pagination for every signed-in caller');
    const buyerPage = await api('GET', '/product/get-all-products?page=1&limit=3', { as: CUSTOMER });
    check('PM-004 buyer can pass limit=3', buyerPage.status === 200 && buyerPage.body.limit === 3,
      buyerPage.body && buyerPage.body.limit);
    check('PM-004 page size respected (<= 3 rows)',
      (buyerPage.body.products || []).length > 0 && (buyerPage.body.products || []).length <= 3,
      (buyerPage.body.products || []).length);
    check('PM-004 reports total, page and totalPages',
      typeof buyerPage.body.total === 'number' && buyerPage.body.page === 1
        && typeof buyerPage.body.totalPages === 'number' && buyerPage.body.totalPages >= 1,
      { total: buyerPage.body.total, page: buyerPage.body.page, totalPages: buyerPage.body.totalPages });

    const buyerPage2 = await api('GET', '/product/get-all-products?page=2&limit=3', { as: CUSTOMER });
    const first1 = (buyerPage.body.products || [])[0];
    const first2 = (buyerPage2.body.products || [])[0];
    check('PM-004 page 2 returns a different window',
      Boolean(first1 && first2) && first1._id !== first2._id, { p1: first1 && first1._id, p2: first2 && first2._id });

    const sellerPage = await api('GET', '/product/get-all-products?page=1&limit=2', { as: SELLER_A });
    check('PM-004 seller list honours limit=2',
      sellerPage.status === 200 && sellerPage.body.limit === 2
        && (sellerPage.body.products || []).length <= 2, sellerPage.body && sellerPage.body.limit);

    const unpaginated = await api('GET', '/product/get-all-products', { as: CUSTOMER });
    check('PM-004 no limit param -> legacy unpaginated response (whole set, one page)',
      unpaginated.status === 200 && (unpaginated.body.products || []).length === unpaginated.body.total
        && unpaginated.body.totalPages === 1,
      { limit: unpaginated.body.limit, rows: (unpaginated.body.products || []).length, total: unpaginated.body.total });

    const adminDefault = await api('GET', '/product/get-all-products', { as: ADMIN });
    check('PM-004 admin default still paginates at 20', adminDefault.body.limit === 20,
      adminDefault.body.limit);

    const guestList = await api('GET', '/product/get-all-products');
    check('PM-004 anonymous list still 401', guestList.status === 401, guestList.status);

    // ── [6] PM-005 - search is bounded and paginated ─────────────────────────
    console.log('\n[6] PM-005 - search pagination and bounds');
    const search2 = await api('GET', `/product/search?q=E2E&limit=2`);
    check('PM-005 search honours limit=2',
      search2.status === 200 && search2.body.limit === 2
        && (search2.body.products || []).length <= 2, search2.body && search2.body.limit);
    check('PM-005 search reports total/page/totalPages',
      typeof search2.body.total === 'number' && typeof search2.body.page === 'number'
        && typeof search2.body.totalPages === 'number',
      { total: search2.body.total, page: search2.body.page, totalPages: search2.body.totalPages });

    const capped = await api('GET', '/product/search?limit=9999');
    check('PM-005 search caps an absurd limit (<= 200)',
      capped.status === 200 && capped.body.limit <= 200, capped.body && capped.body.limit);

    const noQuery = await api('GET', '/product/search');
    check('PM-005 empty query is a bounded list, not a full-collection dump',
      noQuery.status === 200 && noQuery.body.limit <= 200
        && (noQuery.body.products || []).length <= noQuery.body.limit,
      noQuery.body && noQuery.body.limit);

    // ── [7] PM-007 - platform settings limits are actually enforced ──────────
    console.log('\n[7] PM-007 - settings limits (images per product / products per seller)');
    settingsBefore = await Settings.findOne({ key: 'platform' });
    const baseValue = { ...((settingsBefore && settingsBefore.value) || {}) };
    const writeSettings = (value) => Settings.updateOne(
      { key: 'platform' },
      { $set: { key: 'platform', value, updatedAt: new Date() } },
      { upsert: true }
    );

    await writeSettings({ ...baseValue, maxImagesPerProduct: 2 });
    const tooManyImages = await api('POST', '/product/create-product', {
      as: SELLER_A,
      body: payload({ name: 'PM2 Image Cap Widget', imageUrls: `${IMG1},${IMG2},${IMG3}` }),
    });
    check('PM-007 3 images rejected when maxImagesPerProduct = 2 -> 400',
      tooManyImages.status === 400, tooManyImages.body);

    const withinImages = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 Image OK Widget', imageUrls: `${IMG1},${IMG2}` }),
    });
    check('PM-007 2 images accepted when the limit is 2 -> 201',
      withinImages.status === 201, withinImages.body);
    const imageProd = withinImages.body && withinImages.body.product;
    const imageProdId = imageProd && imageProd._id;
    check('PM-007 the 2 images were stored',
      Boolean(imageProd) && Boolean(imageProd.images) && imageProd.images.length === 2,
      imageProd && imageProd.images);

    const overUpdate = await api('PUT', `/product/update-product/${imageProdId}`, {
      as: SELLER_A, body: { imageUrls: IMG4, keepExistingImages: 'true' },
    });
    check('PM-007 update cannot push a product past the image limit -> 400',
      overUpdate.status === 400, overUpdate.body);

    const reAdd = await api('PUT', `/product/update-product/${imageProdId}`, {
      as: SELLER_A, body: { imageUrls: IMG1, keepExistingImages: 'true' },
    });
    check('PM-012 re-adding an existing image keeps 2 entries (no duplicate)',
      reAdd.status === 200 && reAdd.body.product.images.length === 2,
      reAdd.body && reAdd.body.product && reAdd.body.product.images);

    const atLimit = await Product.countDocuments({ shopId: shopAId });
    await writeSettings({ ...baseValue, maxImagesPerProduct: 2, maxProductsPerSeller: atLimit });
    const overCount = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 Over Count Widget' }),
    });
    check('PM-007 product-count cap enforced at maxProductsPerSeller -> 400',
      overCount.status === 400, overCount.body);

    await writeSettings({ ...baseValue, maxImagesPerProduct: 8, maxProductsPerSeller: 500 });
    const underCount = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2 Under Count Widget' }),
    });
    check('PM-007 creation works again once the limit is raised -> 201',
      underCount.status === 201, underCount.body);

    // ── [8] PM-010 - malformed shop ids answer 400 instead of 500 ────────────
    console.log('\n[8] PM-010 - malformed identifier handling');
    const junkShop = await api('GET', '/product/get-all-products-shop/not-a-valid-id');
    check('PM-010 malformed shop id -> 400', junkShop.status === 400, junkShop.status);
    const uuidShop = await api('GET', `/product/get-all-products-shop/${CUSTOMER.id}`);
    check('PM-010 identity UUID passed as a shop id -> 400', uuidShop.status === 400, uuidShop.status);
    const goodShop = await api('GET', `/product/get-all-products-shop/${shopAId}`, { as: SELLER_A });
    check('valid shop id still answers 200', goodShop.status === 200, goodShop.status);
    const emptyShop = await api('GET', `/product/get-all-products-shop/${shopBId}`);
    check('unknown-but-valid shop id answers 200 with no rows',
      emptyShop.status === 200 && (emptyShop.body.products || []).length === 0, emptyShop.status);



    // ── [9] Category integration ─────────────────────────────────────────────
    console.log('\n[9] Category <-> product integration (rename cascade + curation)');
    const { Category } = MODELS;
    const catTitle = 'PM2 Cat A';
    const renamedTitle = 'PM2 Cat B';
    const catDoc = await Category.findOneAndUpdate(
      { title: catTitle, type: 'product' },
      { $set: { title: catTitle, type: 'product', status: 'active', slug: 'pm2-cat-a' } },
      { upsert: true, new: true }
    );
    const catId = String(catDoc._id);

    const catProducts = [];
    for (const [idx, sku] of [[1, 'PM2-CAT-1'], [2, 'PM2-CAT-2'], [3, 'PM2-CAT-3']]) {
      const created = await api('POST', '/product/create-product', {
        as: SELLER_A, body: payload({ name: `PM2CATQ Widget ${idx}`, category: catTitle, sku }),
      });
      const prod = created.body && created.body.product;
      if (prod) catProducts.push(prod);
    }
    check('fixtures: 3 products created in the probe category', catProducts.length === 3,
      catProducts.length);
    // Two published, one left as a DRAFT so the counts have something to ignore.
    await api('POST', `/product/publish/${catProducts[0]._id}`, { as: SELLER_A });
    await api('POST', `/product/publish/${catProducts[1]._id}`, { as: SELLER_A });

    check('public search lists only the 2 published products of an active category',
      productsOf(await search('PM2CATQ')).length === 2,
      productsOf(await search('PM2CATQ')).length);

    const storefrontCats = await api('GET', '/category/active/product');
    const chip = ((storefrontCats.body || {}).categories || []).find((c) => c.title === catTitle);
    check('storefront category count matches the visible products (2, not 3)',
      Boolean(chip) && chip.productCount === 2, chip && chip.productCount);

    const adminCats = await api('GET', '/category?type=product', { as: ADMIN });
    const adminChip = ((adminCats.body || {}).categories || []).find((c) => c.title === catTitle);
    check('admin category list still counts hidden products (>= 3)',
      Boolean(adminChip) && adminChip.productCount >= 3, adminChip && adminChip.productCount);

    // ── rename cascades to every product (the title is the foreign key) ──
    const rename = await api('PUT', `/category/${catId}`, { as: ADMIN, body: { title: renamedTitle } });
    check('renaming a category -> 200', rename.status === 200, rename.body);
    check('rename reports the cascade it performed',
      Boolean(rename.body && rename.body.category) && rename.body.category.cascadedProducts === 3,
      rename.body && rename.body.category && rename.body.category.cascadedProducts);

    const movedCount = await Product.countDocuments({ category: renamedTitle, sku: /^PM2-CAT-/ });
    check('rename re-pointed all 3 products to the new title', movedCount === 3, movedCount);
    check('no product still references the old title',
      (await Product.countDocuments({ category: catTitle })) === 0);
    check('renamed products carry the refreshed categoryId FK',
      (await Product.countDocuments({ _id: catProducts[0]._id, categoryId: catId })) === 1);

    const byNewCategory = await api('GET', `/product/public/all?category=${encodeURIComponent(renamedTitle)}&limit=100`);
    check('public list filters by the renamed category (2 published only)',
      productsOf(byNewCategory).length === 2, productsOf(byNewCategory).length);

    // ── deactivating a category curates its products out of the storefront ──
    const deactivate = await api('PATCH', `/category/${catId}/status`, { as: ADMIN });
    check('deactivating the category -> 200 inactive',
      deactivate.status === 200 && deactivate.body.category.status === 'inactive',
      deactivate.body && deactivate.body.category && deactivate.body.category.status);

    const goneBySearch = productsOf(await search('PM2CATQ')).length;
    check('a deactivated category hides its published products from public search',
      goneBySearch === 0, goneBySearch);
    const goneList = await api('GET', `/product/public/all?category=${encodeURIComponent(renamedTitle)}&limit=100`);
    check('... and from the public category listing', productsOf(goneList).length === 0,
      productsOf(goneList).length);
    check('... and 404s on public detail',
      (await api('GET', `/product/public/${catProducts[0]._id}`)).status === 404);

    const sellerView = await api('GET', `/product/get-all-products-shop/${shopAId}?includeInactive=true`, { as: SELLER_A });
    check('the seller still sees their products in a deactivated category',
      has(sellerView, catProducts[0]._id));
    const adminView = await api('GET', `/product/get-all-products?includeInactive=true&search=${encodeURIComponent('PM2CATQ')}`, { as: ADMIN });
    check('the admin console still sees them', productsOf(adminView).length >= 3,
      productsOf(adminView).length);

    const intoInactive = await api('POST', '/product/create-product', {
      as: SELLER_A, body: payload({ name: 'PM2CATQ Inactive Widget', category: renamedTitle, sku: 'PM2-CAT-4' }),
    });
    check('creating a product in a deactivated category -> 400',
      intoInactive.status === 400, intoInactive.body);

    const reactivate = await api('PATCH', `/category/${catId}/status`, { as: ADMIN });
    check('reactivating the category -> 200 active',
      reactivate.status === 200 && reactivate.body.category.status === 'active');
    const backAgain = productsOf(await search('PM2CATQ')).length;
    check('reactivating restores public visibility of its products', backAgain === 2, backAgain);

    const delInUse = await api('DELETE', `/category/${catId}`, { as: ADMIN });
    check('deleting a category that products still reference -> 409',
      delInUse.status === 409, delInUse.body);

    const renameUnknown = await api('PUT', '/category/64b000000000000000000000', { as: ADMIN, body: { title: 'PM2 Nope' } });
    check('renaming an unknown category -> 404', renameUnknown.status === 404, renameUnknown.status);

    // ── [10] Delete safety: history-bearing products must be archived ────────
    console.log('\n[10] Delete vs archive (order history is protected)');
    const orderedProduct = catProducts[1];
    const orderRes = await api('POST', '/order/create-order', {
      as: CUSTOMER,
      body: {
        cart: [{
          _id: orderedProduct._id, quantity: 1, discountPrice: 0.01, name: orderedProduct.name,
          description: 'pm2 probe', category: catTitle, images: [], shopId: shopAId,
        }],
        totalPrice: 0.01,
        user: { id: CUSTOMER.id, email: CUSTOMER.email },
        destination: { sectorId: 'e2e-sector', fullAddress: 'PM2 probe street', phone: '0911000000' },
        paymentInfo: { type: 'Cash On Delivery' },
      },
    });
    check('fixture: an order referencing the product exists',
      orderRes.status === 200 || orderRes.status === 201, orderRes.body);

    const deleteOrdered = await api('DELETE', `/product/delete-shop-product/${orderedProduct._id}`, { as: SELLER_A });
    check('deleting a product with order history -> 409', deleteOrdered.status === 409, deleteOrdered.body);
    check('the refusal points the seller at archiving instead',
      /archive/i.test((deleteOrdered.body || {}).message || ''), deleteOrdered.body);
    check('the product was NOT deleted',
      (await Product.countDocuments({ _id: orderedProduct._id })) === 1);

    const draftingClean = await api('DELETE', `/product/delete-shop-product/${catProducts[2]._id}`, { as: SELLER_A });
    check('deleting a product with no order history -> 200',
      draftingClean.status === 200, draftingClean.body);
    check('its stock ledger rows went with it',
      (await StockMovement.countDocuments({ productId: String(catProducts[2]._id) })) === 0);

  } finally {
    // Always put the settings doc back exactly as it was found, then drop every
    // probe fixture so the next harness run starts from a clean slate.
    try {
      if (settingsBefore) await Settings.updateOne({ key: 'platform' }, { $set: { value: settingsBefore.value } });
      else await Settings.deleteOne({ key: 'platform' });
    } catch (e) { console.error('[cleanup] settings restore failed:', e.message); }

    try {
      await Product.deleteMany({
        $or: [{ tags: 'pm2probe' }, { sku: { $regex: '^PM2-' } }, { name: { $regex: '^PM2' } }],
      });
      await StockMovement.deleteMany({ shopId: { $in: [shopAId, shopBId] } });
      // Probe categories (the rename cascade moved PM2 Cat A -> PM2 Cat B) and
      // the probe order (its removal is what lets the next run's delete-safety
      // probe start from a clean slate). The ORDER <-> DELIVERY bridge rows go
      // with the orders — this deletes orders directly, so the checkout
      // compensation path never runs for them.
      await MODELS.Category.deleteMany({ title: { $in: ['PM2 Cat A', 'PM2 Cat B'] } });
      const probeOrderIds = (await MODELS.Order.find({ customerId: CUSTOMER.id }, { _id: 1 }).lean())
        .map((o) => String(o._id));
      await MODELS.Order.deleteMany({ customerId: CUSTOMER.id });
      const OrderDelivery = require('../src/modules/orders/models/OrderDeliveries');
      await OrderDelivery.deleteMany({ orderId: { $in: probeOrderIds } });
    } catch (e) { console.error('[cleanup] fixture deletion failed:', e.message); }

  }
  const { pass, fail, failures } = lib.summary();
  console.log(`\n=== Phase-2 probes: ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

run().catch(async (err) => {
  console.error(err);
  const { fail } = lib.summary();
  console.log(`\n=== Phase-2 probes aborted (fail so far: ${fail}) ===`);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
