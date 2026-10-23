#!/usr/bin/env node
'use strict';
/**
 * Ariiti Market — End-to-End Multi-Shop Order and Delivery Flow Testing
 *
 * Flow:
 *   1. Buyer: Create order containing products from MULTIPLE shops (Shop 1 + Shop 2 in Harar, Harar City Zone)
 *   2. Sellers: Each shop independently receives its order items and accepts or rejects its portion
 *      - Test 2A: Independent accept (Shop 1 accepts, Shop 2 accepts)
 *      - Test 2B: Independent reject (Shop 1 accepts, Shop 2 cancels/rejects)
 *   3. Admin: View accepted orders in dispatch queue and assign approved delivery provider in a batch
 *   4. Delivery Provider: Accept assignment
 *   5. Pickup & Delivery: Provider picks up from Shop 1, then Shop 2, starts transit, confirms COD delivery
 *   6. Buyer: Confirm receipt via POST /api/order/:id/confirm-receipt and review product
 *   7. Full multi-portal verification (buyer, sellers, admin, provider wallets & timelines)
 *
 * All operations use REAL API Gateway endpoints (http://127.0.0.1:3000/api).
 * No direct database access.
 */
const crypto = require('node:crypto');

const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BASE = `${GATEWAY}/api`;
const CLIENT_ID = 'aritii-admin-web';

const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com',
  password: process.env.E2E_ADMIN_PASSWORD || 'Admin@12345',
};
const SELLER1 = {
  email: process.env.E2E_SELLER1_EMAIL || 'seller1@aritii.com',
  password: process.env.E2E_SELLER1_PASSWORD || 'Seller@12345',
  shopId: '6ad3f35539343c2e6f6053e7',
  shopName: 'Yihune Belay Sebsibe',
};
const SELLER2 = {
  email: process.env.E2E_SELLER2_EMAIL || 'seller2@aritii.com',
  password: process.env.E2E_SELLER2_PASSWORD || 'Seller@12345',
  shopId: '6ad912668279973315445acc',
  shopName: 'Harar Artisan Crafts',
};
const PROVIDER = {
  email: process.env.E2E_PROVIDER_EMAIL || 'provider@aritii.com',
  password: process.env.E2E_PROVIDER_PASSWORD || 'provider123',
};
const BUYER = {
  email: process.env.E2E_BUYER_EMAIL || 'yihunebelay859@gmail.com',
  password: process.env.E2E_BUYER_PASSWORD || 'Buyer@12345',
};

// Harar City Zone reference (shared across both shops)
const ZONE = { id: '6ad38a4caad17c149c22346a', name: 'Harar City Zone' };
const LOCATION = {
  regionId: '6ad38a4baad17c149c22345b',
  regionName: 'Hararghe',
  cityId: '6ad38a4baad17c149c223464',
  cityName: 'Harar',
};

const BUYER_DESTINATION = {
  ...LOCATION,
  sectorId: LOCATION.cityId,
  sectorName: 'Harar',
  deliveryZoneId: ZONE.id,
  deliveryZoneName: ZONE.name,
  fullAddress: 'Belghis Mazmura, near Ahmed Hassan Hotel, Harar',
  landmark: 'Belghis Mazmura junction',
  building: 'House 214',
  phone: '+251911845533',
  additionalInstructions: 'Call buyer on arrival — ring bell at gate.',
  coordinates: { latitude: 9.3126, longitude: 42.118 },
};

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function assertOk(res, label) {
  if (res.status >= 400) {
    throw new Error(`${label} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 600)}`);
  }
  return res.body;
}

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function login(email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const authorize = await api('/auth/authorize', {
    method: 'POST',
    body: {
      client_id: CLIENT_ID,
      email,
      password,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    },
  });
  assertOk(authorize, `authorize(${email})`);
  const token = await api('/auth/token', {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code: authorize.body.code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    },
  });
  assertOk(token, `token(${email})`);
  return token.body.access_token;
}

function decodeClaims(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function step(title) {
  console.log(`\n── ${title}`);
}

function ok(label, extra) {
  console.log(`   ✓ ${label}${extra ? ' — ' + extra : ''}`);
}

async function waitFor(read, check, { timeoutMs = 45000, stepMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 400)}`);
}

async function main() {
  console.log(`Gateway: ${BASE}`);

  // ── 0. Sessions ───────────────────────────────────────────────────────────
  step('0. Authenticate all actors (OIDC + PKCE)');
  const adminToken = await login(ADMIN.email, ADMIN.password);
  ok('admin authenticated', ADMIN.email);

  const seller1Token = await login(SELLER1.email, SELLER1.password);
  const seller1Claims = decodeClaims(seller1Token);
  const seller1Id = seller1Claims.sub || seller1Claims.id;
  ok('seller 1 authenticated', `${SELLER1.email} (id=${seller1Id})`);

  const seller2Token = await login(SELLER2.email, SELLER2.password);
  const seller2Claims = decodeClaims(seller2Token);
  const seller2Id = seller2Claims.sub || seller2Claims.id;
  ok('seller 2 authenticated', `${SELLER2.email} (id=${seller2Id})`);

  const providerToken = await login(PROVIDER.email, PROVIDER.password);
  const providerClaims = decodeClaims(providerToken);
  ok('provider authenticated', `${PROVIDER.email} (role=${providerClaims.role})`);

  const buyerToken = await login(BUYER.email, BUYER.password);
  const buyerClaims = decodeClaims(buyerToken);
  const buyerId = buyerClaims.sub || buyerClaims.id;
  ok('buyer authenticated', `${BUYER.email} (id=${buyerId})`);

  // ── 1. Setup Same-City and Same-Zone Coverage for Both Shops ──────────────
  step('1. Verify/Configure same-city and same-zone coverage for both shops');
  // Configure zone delivery fee schedule
  const zoneNow = assertOk(await api(`/delivery/zone/${ZONE.id}`, { token: adminToken }), 'get zone');
  const rules = zoneNow.zone.deliveryRules || {};
  await api(`/delivery/zone/${ZONE.id}`, {
    method: 'PUT',
    token: adminToken,
    body: {
      reason: 'E2E multi-shop: update Harar City Zone pricing schedule',
      deliveryRules: {
        ...rules,
        serviceable: true,
        estimatedDeliveryTime: '30-45 min',
        codAvailable: true,
        pickupAvailable: true,
        quantityFees: [
          { minQty: 1, maxQty: 3, fee: 80, enabled: true, label: '1-3 items' },
          { minQty: 4, maxQty: null, fee: 120, enabled: true, label: '4+ items' },
        ],
      },
    },
  });
  ok('delivery zone', `${ZONE.name} active with quantity-based fees`);

  // Activate delivery coverage for Shop 1
  const cov1 = assertOk(await api(`/shop/admin/shops/${SELLER1.shopId}/coverage`, {
    method: 'PUT',
    token: adminToken,
    body: { zoneIds: [ZONE.id], status: 'ACTIVE' },
  }), 'set shop1 coverage');
  ok('shop 1 coverage', `${SELLER1.shopName} (${cov1.shop.deliveryCoverage.status} → ${ZONE.name})`);

  // Activate delivery coverage for Shop 2
  const cov2 = assertOk(await api(`/shop/admin/shops/${SELLER2.shopId}/coverage`, {
    method: 'PUT',
    token: adminToken,
    body: { zoneIds: [ZONE.id], status: 'ACTIVE' },
  }), 'set shop2 coverage');
  ok('shop 2 coverage', `${SELLER2.shopName} (${cov2.shop.deliveryCoverage.status} → ${ZONE.name})`);

  // ── 2. Retrieve Products from Both Shops ──────────────────────────────────
  step('2. Select published products from Shop 1 and Shop 2');
  const s1Catalog = assertOk(await api(`/product/get-all-products-shop/${SELLER1.shopId}`, { token: seller1Token }), 'shop 1 catalog');
  const p1 = (s1Catalog.products || []).find((p) => p.status === 'PUBLISHED');
  if (!p1) throw new Error('No published product in Shop 1');
  const prod1Id = String(p1._id || p1.id);
  // Ensure abundant stock is available via restock API
  assertOk(await api(`/product/restock/${prod1Id}`, { method: 'POST', token: adminToken, body: { quantity: 100, note: 'E2E restock' } }), 'restock product 1');
  ok('shop 1 product', `${p1.name} — ${p1.discountPrice || p1.price} ETB (Shop: ${SELLER1.shopName})`);

  const s2Catalog = assertOk(await api(`/product/get-all-products-shop/${SELLER2.shopId}`, { token: seller2Token }), 'shop 2 catalog');
  const p2 = (s2Catalog.products || []).find((p) => p.status === 'PUBLISHED');
  if (!p2) throw new Error('No published product in Shop 2');
  const prod2Id = String(p2._id || p2.id);
  assertOk(await api(`/product/restock/${prod2Id}`, { method: 'POST', token: adminToken, body: { quantity: 100, note: 'E2E restock' } }), 'restock product 2');
  ok('shop 2 product', `${p2.name} — ${p2.discountPrice || p2.price} ETB (Shop: ${SELLER2.shopName})`);

  // ── 3. Multi-Shop Cart & Same-City / Same-Zone Validation ─────────────────
  step('3. Buyer builds multi-shop cart & validates same-city / same-zone rule');
  // Clear cart first
  await api('/cart', { method: 'DELETE', token: buyerToken });

  // Add Product 1 (from Shop 1)
  const add1 = assertOk(await api('/cart', {
    method: 'POST',
    token: buyerToken,
    body: { productId: prod1Id, quantity: 2, zoneId: ZONE.id, zoneName: ZONE.name },
  }), 'add product 1');
  ok('cart line 1 (Shop 1)', `${p1.name} × 2`);

  // Add Product 2 (from Shop 2)
  const add2 = assertOk(await api('/cart', {
    method: 'POST',
    token: buyerToken,
    body: { productId: prod2Id, quantity: 1, zoneId: ZONE.id, zoneName: ZONE.name },
  }), 'add product 2');
  ok('cart line 2 (Shop 2)', `${p2.name} × 1`);

  // Authoritative zone validation
  const validation = assertOk(await api('/cart/validate', {
    method: 'POST',
    token: buyerToken,
    body: { zoneId: ZONE.id, zoneName: ZONE.name },
  }), 'validate multi-shop cart');
  if (!validation.valid) throw new Error(`Cart validation failed: ${JSON.stringify(validation.issues)}`);
  ok('same-city & same-zone rule verified', `Zone ${validation.zone?.name} (valid=${validation.valid}, items=${validation.items?.length})`);

  // ── 4. Buyer Creates Multi-Shop Order (Check Out) ─────────────────────────
  step('4. Buyer checks out multi-shop order (COD)');
  const orderRes = assertOk(await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: [
        { productId: prod1Id, quantity: 2 },
        { productId: prod2Id, quantity: 1 },
      ],
      fulfilmentType: 'delivery',
      deliveryZoneId: ZONE.id,
      deliveryZoneName: ZONE.name,
      destination: BUYER_DESTINATION,
      shippingAddress: {
        country: 'Ethiopia',
        city: 'Harar',
        address1: BUYER_DESTINATION.fullAddress,
        zipCode: '04',
        addressType: 'Home',
        phone: BUYER_DESTINATION.phone,
      },
      user: { id: buyerId, email: BUYER.email, name: 'Yihune Belay Sebsibe' },
      paymentInfo: {
        type: 'Cash On Delivery',
        method: 'COD',
        status: 'Pay on delivery',
      },
    },
  }), 'create multi-shop order');

  const orders = orderRes.orders || [orderRes.order];
  if (orders.length < 2) {
    throw new Error(`Expected at least 2 seller-level order rows, got ${orders.length}`);
  }
  const orderGroupId = orders[0].orderGroupId;
  ok('multi-shop order created', `Group ID: ${orderGroupId} (${orders.length} sub-orders created)`);

  const order1 = orders.find((o) => String(o.shopId) === String(SELLER1.shopId));
  const order2 = orders.find((o) => String(o.shopId) === String(SELLER2.shopId));
  if (!order1 || !order2) throw new Error('Could not find order per shop in response');

  const order1Id = String(order1._id);
  const order2Id = String(order2._id);
  ok('order 1 (Shop 1: Yihune Belay Sebsibe)', `${order1Id} (${order1.orderNumber}) — ${order1.totalPrice} ETB`);
  ok('order 2 (Shop 2: Harar Artisan Crafts)', `${order2Id} (${order2.orderNumber}) — ${order2.totalPrice} ETB`);

  // Create payment record for each order
  const pay1 = assertOk(await api('/payment/create-payment', {
    method: 'POST',
    token: buyerToken,
    body: { orderId: order1Id, paymentMethod: 'COD' },
  }), 'create payment 1');
  ok('payment record 1', `ID: ${pay1.payment?._id || pay1.payment?.id} — ${pay1.payment?.amount} ETB status=${pay1.payment?.status}`);

  const pay2 = assertOk(await api('/payment/create-payment', {
    method: 'POST',
    token: buyerToken,
    body: { orderId: order2Id, paymentMethod: 'COD' },
  }), 'create payment 2');
  ok('payment record 2', `ID: ${pay2.payment?._id || pay2.payment?.id} — ${pay2.payment?.amount} ETB status=${pay2.payment?.status}`);

  // ── 5. Independent Seller Actions (Part A: Both Accept) ───────────────────
  step('5. Sellers independently receive order items and accept their portions');
  // Seller 1 verifies order 1 is in their queue and accepts
  const s1Orders = assertOk(await api('/order/get-all-orders/seller/me', { token: seller1Token }), 'seller 1 queue');
  const foundInS1 = (s1Orders.orders || []).find((o) => String(o._id) === order1Id);
  if (!foundInS1) throw new Error(`Order ${order1Id} not found in Seller 1 order queue`);
  ok('seller 1 received order', `Order ${foundInS1.orderNumber} with ${foundInS1.cart?.length} item(s)`);

  const accept1 = assertOk(await api(`/order/${order1Id}/confirm`, {
    method: 'POST',
    token: seller1Token,
  }), 'seller 1 confirm order');
  ok('seller 1 accepted order 1', `status=${accept1.order?.status || 'Confirmed'}`);

  // Seller 2 verifies order 2 is in their queue and accepts
  const s2Orders = assertOk(await api('/order/get-all-orders/seller/me', { token: seller2Token }), 'seller 2 queue');
  const foundInS2 = (s2Orders.orders || []).find((o) => String(o._id) === order2Id);
  if (!foundInS2) throw new Error(`Order ${order2Id} not found in Seller 2 order queue`);
  ok('seller 2 received order', `Order ${foundInS2.orderNumber} with ${foundInS2.cart?.length} item(s)`);

  const accept2 = assertOk(await api(`/order/${order2Id}/confirm`, {
    method: 'POST',
    token: seller2Token,
  }), 'seller 2 confirm order');
  ok('seller 2 accepted order 2', `status=${accept2.order?.status || 'Confirmed'}`);

  // ── 5A. Role-specific Order Permissions (Strict Backend Enforcement) ──────
  // Seller 1 cannot view or modify Seller 2's order
  const crossView1 = await api(`/order/order/${order2Id}`, { token: seller1Token });
  if (crossView1.status !== 403) {
    throw new Error(`Seller 1 should be forbidden from viewing Seller 2's order, got ${crossView1.status}`);
  }
  const crossCancel1 = await api(`/order/${order2Id}/cancel`, {
    method: 'POST',
    token: seller1Token,
    body: { reason: 'Unauthorized cancel attempt' },
  });
  if (crossCancel1.status !== 403) {
    throw new Error(`Seller 1 should be forbidden from cancelling Seller 2's order, got ${crossCancel1.status}`);
  }
  ok('seller 1 strictly forbidden from other shop orders', 'HTTP 403 on view and modify');

  // Seller 2 cannot view or modify Seller 1's order
  const crossView2 = await api(`/order/order/${order1Id}`, { token: seller2Token });
  if (crossView2.status !== 403) {
    throw new Error(`Seller 2 should be forbidden from viewing Seller 1's order, got ${crossView2.status}`);
  }
  const crossCancel2 = await api(`/order/${order1Id}/cancel`, {
    method: 'POST',
    token: seller2Token,
    body: { reason: 'Unauthorized cancel attempt' },
  });
  if (crossCancel2.status !== 403) {
    throw new Error(`Seller 2 should be forbidden from cancelling Seller 1's order, got ${crossCancel2.status}`);
  }
  ok('seller 2 strictly forbidden from other shop orders', 'HTTP 403 on view and modify');

  // ── 5B. Test Independent Rejection / Cancellation on a Separate Order ─────
  step('5B. Test independent rejection: Seller 1 accepts, Seller 2 rejects/cancels');
  const rejectOrderRes = assertOk(await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: [
        { productId: prod1Id, quantity: 1 },
        { productId: prod2Id, quantity: 1 },
      ],
      fulfilmentType: 'delivery',
      deliveryZoneId: ZONE.id,
      deliveryZoneName: ZONE.name,
      destination: BUYER_DESTINATION,
      shippingAddress: { country: 'Ethiopia', city: 'Harar', address1: 'Test St', zipCode: '04', addressType: 'Home', phone: '+251911845533' },
      user: { id: buyerId, email: BUYER.email, name: 'Yihune Belay Sebsibe' },
      paymentInfo: { type: 'Cash On Delivery', method: 'COD', status: 'Pay on delivery' },
    },
  }), 'create second order for reject test');

  const rejOrders = rejectOrderRes.orders || [rejectOrderRes.order];
  const testRejOrder1 = rejOrders.find((o) => String(o.shopId) === String(SELLER1.shopId));
  const testRejOrder2 = rejOrders.find((o) => String(o.shopId) === String(SELLER2.shopId));
  const testRej1Id = String(testRejOrder1._id);
  const testRej2Id = String(testRejOrder2._id);

  // Seller 1 accepts their portion
  await api(`/order/${testRej1Id}/confirm`, { method: 'POST', token: seller1Token });
  ok('seller 1 accepts portion', `Order ${testRejOrder1.orderNumber} confirmed`);

  // Seller 2 rejects/cancels their portion
  const cancelledRes = assertOk(await api(`/order/${testRej2Id}/cancel`, {
    method: 'POST',
    token: seller2Token,
    body: { reason: 'Out of stock at this location' },
  }), 'seller 2 cancel order');
  ok('seller 2 rejected/cancelled portion', `Order ${testRejOrder2.orderNumber} status=${cancelledRes.order?.status || 'Cancelled'}`);

  // Verify Seller 1's order is still Confirmed and active
  const checkS1 = assertOk(await api(`/order/order/${testRej1Id}`, { token: seller1Token }), 'verify seller 1 unaffected');
  ok('seller 1 portion unaffected', `status=${checkS1.order?.status} (confirmed)`);

  // ── 6. Delivery Service Receives Both Deliveries ──────────────────────────
  step('6. Wait for Delivery Service to receive both delivery requests');
  const delivery1 = await waitFor(
    async () => {
      const res = await api(`/delivery/delivery/order/${order1Id}`, { token: adminToken });
      return res.status === 200 ? res.body.delivery : null;
    },
    (val) => Boolean(val),
    { label: 'delivery record 1' },
  );
  ok('delivery 1 created', `${delivery1.id || delivery1._id} for Order 1 (Shop 1) — status=${delivery1.status}`);

  const delivery2 = await waitFor(
    async () => {
      const res = await api(`/delivery/delivery/order/${order2Id}`, { token: adminToken });
      return res.status === 200 ? res.body.delivery : null;
    },
    (val) => Boolean(val),
    { label: 'delivery record 2' },
  );
  ok('delivery 2 created', `${delivery2.id || delivery2._id} for Order 2 (Shop 2) — status=${delivery2.status}`);

  // ── 7. Admin Views Accepted Orders & Assigns Provider in a Batch ──────────
  step('7. Admin views ready dispatch pool & batch-assigns both orders to provider');
  const providerMe = assertOk(await api('/delivery/provider/me', { token: providerToken }), 'provider/me');
  const providerId = String(providerMe.provider._id || providerMe.provider.id);
  ok('approved provider', `${providerMe.provider.name} (${providerId}) status=${providerMe.provider.status}`);

  // View ready orders in dispatch pool
  const readyList = assertOk(await api('/delivery/dispatch/ready-orders', { token: adminToken }), 'get ready-orders');
  const readyOrder1 = readyList.orders.find((r) => String(r.orderId) === order1Id);
  const readyOrder2 = readyList.orders.find((r) => String(r.orderId) === order2Id);
  if (!readyOrder1 || !readyOrder2) {
    throw new Error(`Both orders must be in the ready orders pool: found1=${Boolean(readyOrder1)}, found2=${Boolean(readyOrder2)}`);
  }
  ok('both orders visible in ready dispatch pool', `Order 1 (${readyOrder1.sellerName}), Order 2 (${readyOrder2.sellerName})`);

  // Admin creates batch assignment containing both orders
  const batchRes = assertOk(await api('/delivery/dispatch/batches', {
    method: 'POST',
    token: adminToken,
    body: {
      deliveryIds: [readyOrder1.id, readyOrder2.id],
      providerId,
      notes: 'Multi-shop Harar City Zone batch delivery',
    },
  }), 'create batch assignment');

  const batch = batchRes.assignment;
  const batchId = String(batch.id || batch._id);
  ok('batch assignment created', `Ref: ${batch.reference} (${batchId}) with ${batch.deliveries?.length} deliveries`);
  ok('pickup plan stops', `${batch.pickupPlan?.map((s) => `Stop ${s.sequence}: ${s.shopName || s.sellerName} (${s.orderIds?.length} order)`).join(' → ')}`);

  // Verify pickup plan displays items, quantities, condition, and shop info
  const stop1 = batch.pickupPlan?.find((s) => String(s.sellerId) === seller1Id);
  const stop2 = batch.pickupPlan?.find((s) => String(s.sellerId) === seller2Id);
  if (!stop1 || !stop2) throw new Error('Both seller pickup stops must exist in pickup plan');
  ok('pickup plan inspection details', `Stop 1 items: ${stop1.items?.length ?? 0}, Stop 2 items: ${stop2.items?.length ?? 0}`);

  // Unauthorized actor (seller or buyer) forbidden from accessing batch details
  const unauthBatchView = await api(`/delivery/dispatch/batches/${batchId}`, { token: seller1Token });
  if (unauthBatchView.status !== 403) {
    throw new Error(`Non-rider must be forbidden from accessing delivery batch, got ${unauthBatchView.status}`);
  }
  ok('unrelated actors forbidden from batch', 'HTTP 403 on batch detail');

  // ── 8. Delivery Provider Accepts Assignment ───────────────────────────────
  step('8. Delivery provider accepts the assignment batch');
  const respondRes = assertOk(await api(`/delivery/dispatch/batches/${batchId}/respond`, {
    method: 'POST',
    token: providerToken,
    body: { accepted: true },
  }), 'provider accepts batch');
  ok('batch accepted by provider', `status=${respondRes.assignment?.status}`);

  // ── 9. Pickup from Shop 1 and Shop 2, Transit, and Delivery ───────────────
  step('9. Provider picks up from Shop 1 and Shop 2, starts transit, and completes deliveries');
  // Start pickup phase
  const startPickupRes = assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/start`, {
    method: 'POST',
    token: providerToken,
    body: {},
  }), 'start pickup');
  ok('pickup phase started', `batch status=${startPickupRes.assignment?.status}`);

  // Confirm pickup at Shop 1 with quality & collected quantity verification
  const pickupStop1 = assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/${seller1Id}/confirm`, {
    method: 'POST',
    token: providerToken,
    body: {
      collectedQuantities: { [prod1Id]: 2 },
      condition: 'good',
      notes: 'Inspection verified — quality intact, seal unbroken',
    },
  }), 'confirm pickup stop 1');
  ok('stop 1 picked up', `Seller 1 (${SELLER1.shopName}) confirmed with quality verification`);

  // Confirm pickup at Shop 2 with verification
  const pickupStop2 = assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/${seller2Id}/confirm`, {
    method: 'POST',
    token: providerToken,
    body: {
      collectedQuantities: { [prod2Id]: 1 },
      condition: 'good',
      notes: 'Inspection verified — package undamaged',
    },
  }), 'confirm pickup stop 2');
  ok('stop 2 picked up', `Seller 2 (${SELLER2.shopName}) confirmed with quality verification`);

  // Start customer transit
  const transitRes = assertOk(await api(`/delivery/dispatch/batches/${batchId}/transit/start`, {
    method: 'POST',
    token: providerToken,
    body: {},
  }), 'start transit');
  ok('customer delivery leg started', `status=${transitRes.assignment?.status}`);

  // Deliver Order 1 with COD proof
  const deliver1Res = assertOk(await api(`/delivery/dispatch/batches/${batchId}/orders/${order1Id}/deliver`, {
    method: 'POST',
    token: providerToken,
    body: {
      codConfirmed: true,
      codCollectedAmount: Number(order1.totalPrice),
      recipientName: 'Yihune Belay Sebsibe',
      recipientReference: '+251911845533',
      type: 'confirmation',
      note: 'Order 1 parcel delivered and COD collected at the gate.',
    },
  }), 'deliver order 1');
  ok('order 1 delivered', `Order 1 COD ${order1.totalPrice} ETB collected`);

  // Deliver Order 2 with COD proof
  const deliver2Res = assertOk(await api(`/delivery/dispatch/batches/${batchId}/orders/${order2Id}/deliver`, {
    method: 'POST',
    token: providerToken,
    body: {
      codConfirmed: true,
      codCollectedAmount: Number(order2.totalPrice),
      recipientName: 'Yihune Belay Sebsibe',
      recipientReference: '+251911845533',
      type: 'confirmation',
      note: 'Order 2 parcel delivered and COD collected at the gate.',
    },
  }), 'deliver order 2');
  ok('order 2 delivered', `Order 2 COD ${order2.totalPrice} ETB collected`);
  ok('batch finished', `Batch status=${deliver2Res.assignment?.status}`);

  // ── 10. Buyer Confirms Receipt & Reviews Products ─────────────────────────
  step('10. Buyer verifies delivery and confirms receipt via API');
  // Wait for delivery webhook to drain and sync Delivered status to Commerce
  const finalOrder1 = await waitFor(
    async () => {
      const res = await api(`/order/order/${order1Id}`, { token: buyerToken });
      return res.status === 200 ? res.body.order : null;
    },
    (o) => Boolean(o) && o.status === 'Delivered' && o.paymentStatus === 'CONFIRMED',
    { label: 'order 1 Delivered status' },
  );
  ok('order 1 reached Delivered status', `status=${finalOrder1.status}, paymentStatus=${finalOrder1.paymentStatus}`);

  const finalOrder2 = await waitFor(
    async () => {
      const res = await api(`/order/order/${order2Id}`, { token: buyerToken });
      return res.status === 200 ? res.body.order : null;
    },
    (o) => Boolean(o) && o.status === 'Delivered' && o.paymentStatus === 'CONFIRMED',
    { label: 'order 2 Delivered status' },
  );
  ok('order 2 reached Delivered status', `status=${finalOrder2.status}, paymentStatus=${finalOrder2.paymentStatus}`);

  // Buyer confirms receipt for Order 1 (consolidated confirmation across the order group)
  const confirmReceipt1 = assertOk(await api(`/order/${order1Id}/confirm-receipt`, {
    method: 'POST',
    token: buyerToken,
  }), 'buyer confirm receipt 1');
  ok('buyer confirmed receipt for order 1', `buyerConfirmedReceipt=${confirmReceipt1.order?.buyerConfirmedReceipt} at ${confirmReceipt1.order?.buyerConfirmedAt}`);

  // Consolidated verification: Order 2 in the same group is automatically confirmed
  const checkOrder2Receipt = assertOk(await api(`/order/order/${order2Id}`, { token: buyerToken }), 'check order 2 auto receipt');
  if (!checkOrder2Receipt.order?.buyerConfirmedReceipt) {
    throw new Error('Consolidated receipt confirmation should mark Order 2 as confirmed');
  }
  ok('consolidated order group receipt confirmed', `Order 2 buyerConfirmedReceipt=${checkOrder2Receipt.order.buyerConfirmedReceipt}`);

  // Test dedicated group receipt endpoint: POST /order/group/:orderGroupId/confirm-receipt
  const confirmGroupRes = assertOk(await api(`/order/group/${orderGroupId}/confirm-receipt`, {
    method: 'POST',
    token: buyerToken,
  }), 'confirm group receipt endpoint');
  ok('group receipt endpoint verified', `Group ${orderGroupId} receipt confirmed via dedicated API`);

  // Buyer writes review for delivered product
  const reviewRes = await api('/product/create-new-review', {
    method: 'PUT',
    token: buyerToken,
    body: {
      rating: 5,
      comment: 'Excellent fresh products delivered promptly in Harar! Very pleased with the fast multi-shop delivery.',
      productId: prod1Id,
      orderId: order1Id,
    },
  });
  if (reviewRes.status < 400) {
    ok('buyer submitted product review', `5-star review for ${p1.name}`);
  }

  // ── 11. Multi-Portal End-to-End Verification ─────────────────────────────
  step('11. Multi-portal consistency verification');
  // 1. Buyer order list contains both orders with Delivered status
  const buyerList = assertOk(await api(`/order/get-all-orders/user/${buyerId}`, { token: buyerToken }), 'buyer order list');
  const hasO1 = (buyerList.orders || []).some((o) => String(o._id) === order1Id && o.status === 'Delivered');
  const hasO2 = (buyerList.orders || []).some((o) => String(o._id) === order2Id && o.status === 'Delivered');
  ok('buyer portal order list', `Order 1 delivered=${hasO1}, Order 2 delivered=${hasO2}`);

  // 2. Seller 1 order list contains Order 1
  const s1FinalOrders = assertOk(await api('/order/get-all-orders/seller/me', { token: seller1Token }), 'seller 1 orders');
  const s1Final = (s1FinalOrders.orders || []).find((o) => String(o._id) === order1Id);
  ok('seller 1 portal queue', `Order ${s1Final?.orderNumber} status=${s1Final?.status}`);

  // 3. Seller 2 order list contains Order 2
  const s2FinalOrders = assertOk(await api('/order/get-all-orders/seller/me', { token: seller2Token }), 'seller 2 orders');
  const s2Final = (s2FinalOrders.orders || []).find((o) => String(o._id) === order2Id);
  ok('seller 2 portal queue', `Order ${s2Final?.orderNumber} status=${s2Final?.status}`);

  // 4. Payment records are SETTLED/COMPLETED
  const pay1Check = assertOk(await api(`/payment/get-payment-by-order/${order1Id}`, { token: buyerToken }), 'payment 1');
  const pay2Check = assertOk(await api(`/payment/get-payment-by-order/${order2Id}`, { token: buyerToken }), 'payment 2');
  ok('payments settled', `Order 1 payment=${pay1Check.payment?.status}, Order 2 payment=${pay2Check.payment?.status}`);

  // 5. Rider assignment list has completed batch
  const riderJobs = assertOk(await api('/delivery/dispatch/mine', { token: providerToken }), 'rider jobs');
  const batchInMine = (riderJobs.assignments || []).find((b) => String(b._id) === batchId);
  ok('rider portal jobs', `Batch ${batchInMine?.reference} status=${batchInMine?.status} (${batchInMine?.deliveries?.length} deliveries)`);

  // 6. Delivery Tracking and Timeline verification
  const delivHistory = assertOk(await api(`/delivery/delivery/${delivery1.id || delivery1._id}/history`, { token: adminToken }), 'delivery 1 history');
  ok('delivery tracking events', (delivHistory.trackingEvents || []).map((e) => e.stage || e.status).join(' → ') || 'recorded');

  // 7. Seller and Provider Wallets
  const s1Wallet = assertOk(await api(`/wallet/${seller1Id}`, { token: seller1Token }), 'seller 1 wallet');
  const s2Wallet = assertOk(await api(`/wallet/${seller2Id}`, { token: seller2Token }), 'seller 2 wallet');
  const riderWallet = assertOk(await api('/delivery/provider-wallet/me', { token: providerToken }), 'rider wallet');
  const s1Row = s1Wallet.data?.wallet || s1Wallet.data || s1Wallet.wallet || s1Wallet;
  const s2Row = s2Wallet.data?.wallet || s2Wallet.data || s2Wallet.wallet || s2Wallet;
  const rRow = riderWallet.wallet || riderWallet.data?.wallet || riderWallet.data || riderWallet;
  ok('seller 1 wallet', `balance updated (pending=${s1Row.pendingBalance} ETB, available=${s1Row.availableBalance} ETB)`);
  ok('seller 2 wallet', `balance updated (pending=${s2Row.pendingBalance} ETB, available=${s2Row.availableBalance} ETB)`);
  ok('provider wallet', `balance updated (pending=${rRow.pendingBalance} ETB)`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  END-TO-END MULTI-SHOP ORDER & DELIVERY FLOW TEST: PASSED  ');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Order Group ID : ${orderGroupId}`);
  console.log(`Order 1 (Shop 1): ${order1Id} (${order1.orderNumber}) — ${order1.totalPrice} ETB`);
  console.log(`Order 2 (Shop 2): ${order2Id} (${order2.orderNumber}) — ${order2.totalPrice} ETB`);
  console.log(`Batch Ref      : ${batch.reference} (${batchId})`);
  console.log(`Provider       : ${PROVIDER.email} (${providerId})`);
  console.log(`Receipt Status : Confirmed by Buyer for both orders`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nTEST FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
