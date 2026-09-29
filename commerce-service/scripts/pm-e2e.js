#!/usr/bin/env node
/** Product Management E2E — harness lives in scripts/pm-e2e-lib.js. */
const mongoose = require('mongoose');
const lib = require('./pm-e2e-lib');

const { api, check, fixtures, MODELS, SELLER_A, SELLER_B, ADMIN, CUSTOMER } = lib;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/ariti_commerce';

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const { shopA, shopB } = await fixtures();
  const shopAId = String(shopA._id);
  const shopBId = String(shopB._id);

  console.log('\n[1] Seller lifecycle: create → DRAFT → publish');
  const create = await api('POST', '/product/create-product', {
    as: SELLER_A,
    body: {
      name: 'E2E Widget', description: 'An end-to-end test widget for product management.',
      category: 'E2E Cat', discountPrice: 100, originalPrice: 150, stock: 10,
      shopId: shopAId, sku: 'E2E-1', tags: 'e2e',
    },
  });
  check('create returns 201', create.status === 201, create.body);
  const prod = create.body && create.body.product;
  check('new product is DRAFT (not live at creation)', prod && prod.status === 'DRAFT', prod && prod.status);
  check('currency defaults to ETB', prod && prod.currency === 'ETB', prod && prod.currency);
  check('categoryId FK resolved from the title', Boolean(prod && prod.categoryId), prod && prod.categoryId);
  const productId = prod && (prod._id || prod.id);

  const draftList = await api('GET', '/product/public/all');
  check('draft absent from public list', !((draftList.body || {}).products || []).some((p) => p._id === productId));
  const draftDetail = await api('GET', `/product/public/${productId}`);
  check('draft 404s on public detail', draftDetail.status === 404, draftDetail.status);

  const published = await api('POST', `/product/publish/${productId}`, { as: SELLER_A });
  check('publish → PUBLISHED', published.status === 200 && published.body.product.status === 'PUBLISHED', published.body);

  const publicList = await api('GET', '/product/public/all');
  check('published product is publicly listed', ((publicList.body || {}).products || []).some((p) => p._id === productId));
  const publicDetail = await api('GET', `/product/public/${productId}`);
  check('public detail returns stock', publicDetail.status === 200 && typeof publicDetail.body.product.stock === 'number');
  check('public detail strips seller wallet PII', !!(publicDetail.body.product.shop && publicDetail.body.product.shop.availableBalance === undefined));

  console.log('\n[2] Admin kill-switch (activate / deactivate)');
  const off = await api('POST', '/product/bulk', { as: ADMIN, body: { productIds: [productId], action: 'deactivate' } });
  check('bulk deactivate 200', off.status === 200, off.body);
  const afterOff = await api('GET', '/product/public/all');
  check('deactivated product hidden from public', !((afterOff.body || {}).products || []).some((p) => p._id === productId));
  const ownerView = await api('GET', `/product/get-product/${productId}`, { as: SELLER_A });
  check('owner still sees the deactivated product', ownerView.status === 200, ownerView.status);
  const on = await api('POST', '/product/bulk', { as: ADMIN, body: { productIds: [productId], action: 'activate' } });
  check('bulk activate 200', on.status === 200, on.body);
  const afterOn = await api('GET', '/product/public/all');
  check('reactivated product public again', ((afterOn.body || {}).products || []).some((p) => p._id === productId));

  console.log('\n[3] Admin shop "allow in public" + product cascade');
  const hiddenShop = await api('GET', `/shop/public/${shopBId}`);
  check('non-public shop 404s publicly', hiddenShop.status === 404, hiddenShop.status);

  const createB = await api('POST', '/product/create-product', {
    as: SELLER_B,
    body: { name: 'E2E ShopB Item', description: 'Item of a shop hidden from the public view.', category: 'E2E Cat', discountPrice: 50, stock: 4, shopId: shopBId },
  });
  const productBId = createB.body && createB.body.product && (createB.body.product._id || createB.body.product.id);
  await api('POST', `/product/publish/${productBId}`, { as: SELLER_B });
  const bHidden = await api('GET', '/product/public/all');
  check('product of a non-public shop is hidden', !((bHidden.body || {}).products || []).some((p) => p._id === productBId));

  const allow = await api('PATCH', `/shop/admin/shops/${shopBId}/public`, { as: ADMIN, body: { showOnPublic: true } });
  check('admin toggle allow 200', allow.status === 200, allow.body);
  const bVisible = await api('GET', '/product/public/all');
  check('cascade: products public after the shop is allowed', ((bVisible.body || {}).products || []).some((p) => p._id === productBId));
  const shopBPublic = await api('GET', `/shop/public/${shopBId}`);
  check('shop visible publicly after the toggle', shopBPublic.status === 200, shopBPublic.status);

  const disallow = await api('PATCH', `/shop/admin/shops/${shopBId}/public`, { as: ADMIN, body: { showOnPublic: false } });
  check('admin toggle hide 200', disallow.status === 200, disallow.body);
  const bHiddenAgain = await api('GET', '/product/public/all');
  check('cascade: products hidden again', !((bHiddenAgain.body || {}).products || []).some((p) => p._id === productBId));

  console.log('\n[4] Category public curation');
  const guestCats = await api('GET', '/category');
  const guestTitles = ((guestCats.body || {}).categories || []).map((c) => c.title);
  check('guest sees the active category', guestTitles.includes('E2E Cat'));
  check('guest does NOT see the inactive category', !guestTitles.includes('E2E Hidden Cat'));
  const guestForced = await api('GET', '/category?status=inactive');
  check('guest cannot force ?status=inactive', !((guestForced.body || {}).categories || []).some((c) => c.title === 'E2E Hidden Cat'));
  const adminCats = await api('GET', '/category', { as: ADMIN });
  check('admin sees inactive categories too', ((adminCats.body || {}).categories || []).some((c) => c.title === 'E2E Hidden Cat'));

  console.log('\n[5] /shop/getseller resolution contract');
  const asCustomer = await api('GET', '/shop/getseller', { as: CUSTOMER });
  check('customer → 200 with seller:null (no 404)', asCustomer.status === 200 && asCustomer.body.seller === null, asCustomer);
  const asSeller = await api('GET', '/shop/getseller', { as: SELLER_A });
  check('seller resolves their shop', asSeller.status === 200 && Boolean(asSeller.body.seller), asSeller.status);
  const asSellerB = await api('GET', '/shop/getseller', { as: SELLER_B });
  check('owner sees own shop even when hidden from public', asSellerB.status === 200 && Boolean(asSellerB.body.seller), asSellerB.status);

  console.log('\n[6] Seller orders by shop id (was 403)');
  const ordersByShop = await api('GET', `/order/get-all-orders/seller/${shopAId}`, { as: SELLER_A });
  check('orders endpoint accepts the owned shop id (200)', ordersByShop.status === 200, ordersByShop.status);
  const ordersByForeignShop = await api('GET', `/order/get-all-orders/seller/${shopBId}`, { as: SELLER_A });
  check("another seller's shop id → 403", ordersByForeignShop.status === 403, ordersByForeignShop.status);

  console.log('\n[7] Inventory: restock / set-total / ledger / availability');
  const restock = await api('POST', `/product/restock/${productId}`, { as: SELLER_A, body: { quantity: 5, note: 'e2e delivery' } });
  check('restock 200', restock.status === 200, restock.body);
  let live = (await api('GET', `/product/get-product/${productId}`, { as: SELLER_A })).body.product;
  check('stock 10 → 15 after restock', live && live.stock === 15, live && live.stock);
  const adjust = await api('PUT', `/product/adjust-stock/${productId}`, { as: SELLER_A, body: { quantity: 7, note: 'e2e count' } });
  check('set-total → stock = 7', adjust.status === 200 && adjust.body.product.stock === 7, adjust.body.product && adjust.body.product.stock);
  const history = await api('GET', `/product/stock-history/${productId}`, { as: SELLER_A });
  const types = (history.body.movements || []).map((m) => m.type);
  check('ledger has restock + adjustment entries', types.includes('restock') && types.includes('adjustment'), types);
  const availability = await api('GET', `/order/availability/${productId}`);
  check('availability 200 for a public product', availability.status === 200, availability.status);
  const badPrice = await api('POST', '/product/create-product', { as: SELLER_A, body: { name: 'E2E Bad', description: 'negative price must be rejected here', category: 'E2E Cat', discountPrice: -5, stock: 1, shopId: shopAId } });
  check('negative price rejected (400)', badPrice.status === 400, badPrice.status);

  console.log('\n[8] Order: server re-pricing + quantity + reservation');
  const order = await api('POST', '/order/create-order', {
    as: CUSTOMER,
    body: {
      cart: [{ _id: productId, quantity: 2, discountPrice: 0.01, name: 'E2E Widget', description: 'x', category: 'E2E Cat', images: [], shopId: shopAId }],
      totalPrice: 0.02, // client manipulation attempt — the server must ignore it
      user: { id: CUSTOMER.id, email: CUSTOMER.email },
      destination: { sectorId: 'e2e-sector', fullAddress: 'E2E street 1', phone: '0911000000' },
      paymentInfo: { type: 'Cash On Delivery' },
    },
  });
  check('order created', (order.status === 200 || order.status === 201), order.body);
  const ordersList = (order.body || {}).orders;
  const firstOrder = Array.isArray(ordersList) ? ordersList[0] : ordersList;
  // Real price 100 × qty 2 = 200 + 3% shipping (6) = 206 — not the client's 0.02.
  check('server re-priced the order (≈206, client 0.02 ignored)', firstOrder && Math.abs(firstOrder.totalPrice - 206) < 0.01, firstOrder && firstOrder.totalPrice);
  live = (await api('GET', `/product/get-product/${productId}`, { as: SELLER_A })).body.product;
  check('reservation honored quantity 2 (reserved=2, stock unchanged)', live && live.reserved === 2 && live.stock === 7, { reserved: live && live.reserved, stock: live && live.stock });

  console.log('\n[9] Payment confirmation: idempotent; cancel-after-confirm restocks');
  const orderId = firstOrder && (firstOrder._id || firstOrder.id);
  const confirm1 = await api('POST', `/order/confirm-payment/${orderId}`, { as: CUSTOMER });
  check('confirm #1 → 200', confirm1.status === 200, confirm1.body);
  const confirm2 = await api('POST', `/order/confirm-payment/${orderId}`, { as: CUSTOMER });
  check('confirm #2 → 400 (no double deduct)', confirm2.status === 400, confirm2.status);
  live = (await api('GET', `/product/get-product/${productId}`, { as: SELLER_A })).body.product;
  check('stock deducted exactly once (7→5)', live && live.stock === 5, live && live.stock);
  check('reservation consumed (reserved=0)', live && live.reserved === 0, live && live.reserved);
  const moves = (await api('GET', `/product/stock-history/${productId}`, { as: SELLER_A })).body.movements;
  check('exactly one order_confirmed movement', moves.filter((m) => m.type === 'order_confirmed').length === 1);

  const cancel = await api('POST', `/order/cancel/${orderId}`, { as: CUSTOMER, body: { reason: 'e2e cancel' } });
  check('cancel-after-confirm → 200', cancel.status === 200, cancel.body);
  live = (await api('GET', `/product/get-product/${productId}`, { as: SELLER_A })).body.product;
  check('confirmed units restocked (5→7)', live && live.stock === 7, live && live.stock);

  console.log('\n[10] Search + seller-draft gates');
  const draftCreate = await api('POST', '/product/create-product', {
    as: SELLER_A,
    body: { name: 'E2E Unlisted Gadget', description: 'Must never appear in public search', category: 'E2E Cat', discountPrice: 30, stock: 2, shopId: shopAId },
  });
  const draftId = draftCreate.body && draftCreate.body.product && (draftCreate.body.product._id || draftCreate.body.product.id);
  const search = await api('GET', `/product/search?q=${encodeURIComponent('E2E Unlisted Gadget')}`);
  check('draft absent from search results', !((search.body || {}).products || []).some((p) => p._id === draftId));
  const badStock = await api('POST', '/product/create-product', {
    as: SELLER_A,
    body: { name: 'E2E Bad Stock', description: 'negative stock must be rejected', category: 'E2E Cat', discountPrice: 10, stock: -3, shopId: shopAId },
  });
  check('negative stock rejected (400)', badStock.status === 400, badStock.status);
}

run()
  .then(async () => {
    const { pass, fail, failures } = lib.summary();
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    if (fail) console.log('Failed checks:\n - ' + failures.join('\n - '));
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('\nFATAL:', err && err.message ? err.message : err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
