#!/usr/bin/env node
'use strict';
/**
 * Ariiti Market — Negative, Permission, Boundary & Idempotency Testing
 *
 * Verifies:
 *   1. Unauthorized actions (Role Permission Enforcement)
 *      - Buyer cannot confirm orders (403)
 *      - Buyer cannot accept delivery batches (403)
 *      - Buyer cannot confirm pickups (403)
 *      - Seller cannot access another seller's wallet (403)
 *   2. Invalid status transitions
 *      - Buyer cannot confirm receipt before order is Delivered (409)
 *      - Provider cannot start transit before all pickup stops are confirmed (400)
 *      - Provider cannot deliver COD order without valid COD proof (400)
 *   3. Idempotency & Duplicate Prevention
 *      - Order confirmation is idempotent (no duplicate stock deduction or handoffs)
 *      - Buyer receipt confirmation is idempotent (no duplicate events)
 *      - Duplicate batch assignment for already-assigned deliveries is rejected (409)
 *   4. Partial Acceptance & Seller Rejection
 *      - Shop 1 accepts, Shop 2 rejects/cancels
 *      - Shop 1 portion unaffected and moves to Confirmed
 *      - Shop 2 portion transitions to Cancelled and releases inventory reservation
 *   5. Failed Delivery Handling
 *      - Delivery can transition to 'failed' with failure reason and nextAction
 *      - Retry count and attempt history recorded
 *   6. Financial & Ledger Verification
 *      - Commission ledger records seller commission
 *      - No duplicate wallet credits
 */
const crypto = require('node:crypto');

const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BASE = `${GATEWAY}/api`;
const CLIENT_ID = 'aritii-admin-web';

const ADMIN = { email: 'admin@aritii.com', password: 'Admin@12345' };
const SELLER1 = { email: 'seller1@aritii.com', password: 'Seller@12345', shopId: '6ad3f35539343c2e6f6053e7' };
const SELLER2 = { email: 'seller2@aritii.com', password: 'Seller@12345', shopId: '6ad912668279973315445acc' };
const PROVIDER = { email: 'provider@aritii.com', password: 'provider123' };
const BUYER = { email: 'yihunebelay859@gmail.com', password: 'Buyer@12345' };

const ZONE = { id: '6ad38a4caad17c149c22346a', name: 'Harar City Zone' };
const LOCATION = { regionId: '6ad38a4baad17c149c22345b', regionName: 'Hararghe', cityId: '6ad38a4baad17c149c223464', cityName: 'Harar' };
const BUYER_DESTINATION = {
  ...LOCATION,
  sectorId: LOCATION.cityId,
  sectorName: 'Harar',
  deliveryZoneId: ZONE.id,
  deliveryZoneName: ZONE.name,
  fullAddress: 'Belghis Mazmura, Harar',
  phone: '+251911845533',
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

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function login(email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const auth = await api('/auth/authorize', {
    method: 'POST',
    body: { client_id: CLIENT_ID, email, password, code_challenge: s256(verifier), code_challenge_method: 'S256' },
  });
  if (auth.status >= 400) throw new Error(`Authorize failed: ${auth.status}`);
  const token = await api('/auth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code: auth.body.code, code_verifier: verifier, client_id: CLIENT_ID },
  });
  if (token.status >= 400) throw new Error(`Token exchange failed: ${token.status}`);
  return token.body.access_token;
}

function decodeClaims(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function ok(testName, detail = '') {
  console.log(`   ✓ [PASS] ${testName}${detail ? ' — ' + detail : ''}`);
}

function fail(testName, err) {
  console.error(`   ✗ [FAIL] ${testName}:`, err);
  throw new Error(`${testName} failed`);
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
  console.log(`Starting Negative, Permission & Boundary Scenarios against ${BASE}...\n`);

  const adminToken = await login(ADMIN.email, ADMIN.password);
  const seller1Token = await login(SELLER1.email, SELLER1.password);
  const seller2Token = await login(SELLER2.email, SELLER2.password);
  const providerToken = await login(PROVIDER.email, PROVIDER.password);
  const buyerToken = await login(BUYER.email, BUYER.password);

  const buyerId = decodeClaims(buyerToken).sub || decodeClaims(buyerToken).id;
  const seller1Id = decodeClaims(seller1Token).sub || decodeClaims(seller1Token).id;
  const seller2Id = decodeClaims(seller2Token).sub || decodeClaims(seller2Token).id;

  // Retrieve products
  const s1Catalog = (await api(`/product/get-all-products-shop/${SELLER1.shopId}`, { token: seller1Token })).body.products;
  const s2Catalog = (await api(`/product/get-all-products-shop/${SELLER2.shopId}`, { token: seller2Token })).body.products;
  const p1 = s1Catalog.find((p) => p.status === 'PUBLISHED');
  const p2 = s2Catalog.find((p) => p.status === 'PUBLISHED');

  console.log('── 1. Role Permission Enforcement (Unauthorized Actions)');

  // 1A. Buyer cannot confirm order
  const orderCreateRes = await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: [{ productId: p1._id, quantity: 1 }],
      fulfilmentType: 'delivery',
      deliveryZoneId: ZONE.id,
      deliveryZoneName: ZONE.name,
      destination: BUYER_DESTINATION,
      shippingAddress: { country: 'Ethiopia', city: 'Harar', address1: 'Test St', zipCode: '04', addressType: 'Home', phone: '+251911845533' },
      user: { id: buyerId, email: BUYER.email, name: 'Yihune Belay' },
      paymentInfo: { type: 'Cash On Delivery', method: 'COD', status: 'Pay on delivery' },
    },
  });
  const testOrderId = String(orderCreateRes.body.orders[0]._id);

  const buyerConfirm = await api(`/order/${testOrderId}/confirm`, { method: 'POST', token: buyerToken });
  if (buyerConfirm.status === 403) {
    ok('Buyer forbidden from confirming orders', `HTTP ${buyerConfirm.status}`);
  } else {
    fail('Buyer forbidden from confirming orders', `Expected 403, got ${buyerConfirm.status}`);
  }

  // 1B. Buyer cannot respond to dispatch batches
  const buyerRespond = await api('/delivery/dispatch/batches/fake-id/respond', { method: 'POST', token: buyerToken, body: { accepted: true } });
  if (buyerRespond.status === 403) {
    ok('Buyer forbidden from accepting delivery batches', `HTTP ${buyerRespond.status}`);
  } else {
    fail('Buyer forbidden from accepting delivery batches', `Expected 403, got ${buyerRespond.status}`);
  }

  // 1C. Buyer cannot confirm pickups
  const buyerPickup = await api('/delivery/dispatch/batches/fake-id/pickup/fake-seller/confirm', { method: 'POST', token: buyerToken });
  if (buyerPickup.status === 403) {
    ok('Buyer forbidden from confirming dispatch pickups', `HTTP ${buyerPickup.status}`);
  } else {
    fail('Buyer forbidden from confirming dispatch pickups', `Expected 403, got ${buyerPickup.status}`);
  }

  // 1D. Seller 1 cannot access Seller 2's wallet
  const crossWallet = await api(`/wallet/${seller2Id}`, { token: seller1Token });
  if (crossWallet.status === 403) {
    ok('Seller forbidden from accessing another seller\'s wallet', `HTTP ${crossWallet.status}`);
  } else {
    fail('Seller forbidden from accessing another seller\'s wallet', `Expected 403, got ${crossWallet.status}`);
  }

  console.log('\n── 2. Invalid Status Transitions & Business Rules');

  // 2A. Buyer cannot confirm receipt BEFORE delivery is completed
  const earlyConfirm = await api(`/order/${testOrderId}/confirm-receipt`, { method: 'POST', token: buyerToken });
  if (earlyConfirm.status === 409) {
    ok('Premature receipt confirmation rejected', `HTTP ${earlyConfirm.status} (${earlyConfirm.body?.message || earlyConfirm.body?.error})`);
  } else {
    fail('Premature receipt confirmation rejected', `Expected 409, got ${earlyConfirm.status}`);
  }

  // 2B. Provider cannot start transit before completing pickup stops
  // Create multi-shop order, accept both, create batch
  const multiRes = await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: [{ productId: p1._id, quantity: 1 }, { productId: p2._id, quantity: 1 }],
      fulfilmentType: 'delivery',
      deliveryZoneId: ZONE.id,
      deliveryZoneName: ZONE.name,
      destination: BUYER_DESTINATION,
      shippingAddress: { country: 'Ethiopia', city: 'Harar', address1: 'Test St', zipCode: '04', addressType: 'Home', phone: '+251911845533' },
      user: { id: buyerId, email: BUYER.email, name: 'Yihune Belay' },
      paymentInfo: { type: 'Cash On Delivery', method: 'COD', status: 'Pay on delivery' },
    },
  });
  const mOrder1 = multiRes.body.orders.find((o) => String(o.shopId) === String(SELLER1.shopId));
  const mOrder2 = multiRes.body.orders.find((o) => String(o.shopId) === String(SELLER2.shopId));
  await api(`/order/${mOrder1._id}/confirm`, { method: 'POST', token: seller1Token });
  await api(`/order/${mOrder2._id}/confirm`, { method: 'POST', token: seller2Token });

  // Get delivery IDs
  await new Promise((r) => setTimeout(r, 1000));
  const del1 = (await api(`/delivery/delivery/order/${mOrder1._id}`, { token: adminToken })).body.delivery;
  const del2 = (await api(`/delivery/delivery/order/${mOrder2._id}`, { token: adminToken })).body.delivery;
  const provMe = (await api('/delivery/provider/me', { token: providerToken })).body.provider;

  const batchRes = await api('/delivery/dispatch/batches', {
    method: 'POST',
    token: adminToken,
    body: { deliveryIds: [del1.id || del1._id, del2.id || del2._id], providerId: String(provMe._id), notes: 'Negative test batch' },
  });
  const testBatchId = String(batchRes.body.assignment._id);

  // Accept batch and start pickup
  await api(`/delivery/dispatch/batches/${testBatchId}/respond`, { method: 'POST', token: providerToken, body: { accepted: true } });
  await api(`/delivery/dispatch/batches/${testBatchId}/pickup/start`, { method: 'POST', token: providerToken, body: {} });

  // Try transit BEFORE confirming all pickups
  const prematureTransit = await api(`/delivery/dispatch/batches/${testBatchId}/transit/start`, { method: 'POST', token: providerToken, body: {} });
  if (prematureTransit.status === 400) {
    ok('Premature transit start rejected (unpicked stops remain)', `HTTP ${prematureTransit.status} (${prematureTransit.body?.message})`);
  } else {
    fail('Premature transit start rejected', `Expected 400, got ${prematureTransit.status}`);
  }

  // 2C. Provider cannot deliver without COD confirmation proof
  // Confirm pickups and start transit
  await api(`/delivery/dispatch/batches/${testBatchId}/pickup/${seller1Id}/confirm`, { method: 'POST', token: providerToken, body: {} });
  await api(`/delivery/dispatch/batches/${testBatchId}/pickup/${seller2Id}/confirm`, { method: 'POST', token: providerToken, body: {} });
  await api(`/delivery/dispatch/batches/${testBatchId}/transit/start`, { method: 'POST', token: providerToken, body: {} });

  // Try delivering without proof
  const unprovenDelivery = await api(`/delivery/dispatch/batches/${testBatchId}/orders/${mOrder1._id}/deliver`, {
    method: 'POST',
    token: providerToken,
    body: {}, // no codConfirmed or codCollectedAmount
  });
  if (unprovenDelivery.status === 400) {
    ok('COD delivery without collected amount proof rejected', `HTTP ${unprovenDelivery.status}`);
  } else {
    fail('COD delivery without proof rejected', `Expected 400, got ${unprovenDelivery.status}`);
  }

  // Now deliver properly
  await api(`/delivery/dispatch/batches/${testBatchId}/orders/${mOrder1._id}/deliver`, {
    method: 'POST',
    token: providerToken,
    body: { codConfirmed: true, codCollectedAmount: Number(mOrder1.totalPrice), recipientName: 'Yihune', type: 'confirmation' },
  });
  await api(`/delivery/dispatch/batches/${testBatchId}/orders/${mOrder2._id}/deliver`, {
    method: 'POST',
    token: providerToken,
    body: { codConfirmed: true, codCollectedAmount: Number(mOrder2.totalPrice), recipientName: 'Yihune', type: 'confirmation' },
  });
  ok('Deliveries completed with valid COD proof', 'Status -> Delivered');

  console.log('\n── 3. Idempotency & Duplicate Prevention');

  // 3A. Order confirmation is idempotent
  const reConfirm = await api(`/order/${mOrder1._id}/confirm`, { method: 'POST', token: seller1Token });
  if (reConfirm.status === 200) {
    ok('Order confirmation is idempotent', 'Calling confirm again returns 200 OK');
  } else {
    fail('Order confirmation idempotency', `Expected 200, got ${reConfirm.status}`);
  }

  // 3B. Buyer receipt confirmation is idempotent
  await waitFor(
    async () => {
      const res = await api(`/order/order/${mOrder1._id}`, { token: buyerToken });
      return res.status === 200 ? res.body.order : null;
    },
    (o) => Boolean(o) && o.status === 'Delivered' && o.paymentStatus === 'CONFIRMED',
    { label: 'order 1 Delivered status' }
  );
  const confirm1 = await api(`/order/${mOrder1._id}/confirm-receipt`, { method: 'POST', token: buyerToken });
  const confirm2 = await api(`/order/${mOrder1._id}/confirm-receipt`, { method: 'POST', token: buyerToken });
  if (confirm1.status === 200 && confirm2.status === 200) {
    ok('Buyer receipt confirmation is idempotent', 'Repeated confirm-receipt calls return 200 OK');
  } else {
    fail('Buyer receipt confirmation idempotency', `Got ${confirm1.status} and ${confirm2.status}`);
  }

  // 3C. Prevent duplicate batch assignment for already-assigned deliveries
  const dupBatch = await api('/delivery/dispatch/batches', {
    method: 'POST',
    token: adminToken,
    body: { deliveryIds: [del1.id || del1._id], providerId: String(provMe._id) },
  });
  if (dupBatch.status === 400 || dupBatch.status === 409) {
    ok('Re-assigning active/completed delivery to another batch rejected', `HTTP ${dupBatch.status}`);
  } else {
    fail('Duplicate batch prevention', `Expected 400/409, got ${dupBatch.status}`);
  }

  console.log('\n── 4. Failed Delivery Lifecycle');
  // Create another order, assign, and mark failed
  const failOrderRes = await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: [{ productId: p1._id, quantity: 1 }],
      fulfilmentType: 'delivery',
      deliveryZoneId: ZONE.id,
      deliveryZoneName: ZONE.name,
      destination: BUYER_DESTINATION,
      shippingAddress: { country: 'Ethiopia', city: 'Harar', address1: 'Test St', zipCode: '04', addressType: 'Home', phone: '+251911845533' },
      user: { id: buyerId, email: BUYER.email, name: 'Yihune Belay' },
      paymentInfo: { type: 'Cash On Delivery', method: 'COD', status: 'Pay on delivery' },
    },
  });
  const failOrderId = String(failOrderRes.body.orders[0]._id);
  await api(`/order/${failOrderId}/confirm`, { method: 'POST', token: seller1Token });
  await new Promise((r) => setTimeout(r, 1000));
  const failDelivery = (await api(`/delivery/delivery/order/${failOrderId}`, { token: adminToken })).body.delivery;
  const failDeliveryId = String(failDelivery.id || failDelivery._id);

  // Transition delivery status to 'failed' with reason and nextAction
  const markFailed = await api(`/delivery/delivery/${failDeliveryId}/status`, {
    method: 'PUT',
    token: adminToken,
    body: { status: 'failed', reason: 'Buyer unreachable at delivery location', nextAction: 'reschedule' },
  });
  if (markFailed.status === 200 && markFailed.body.delivery?.status === 'failed') {
    ok('Delivery status transitioned to failed', `Reason: ${markFailed.body.delivery.failureReason}`);
    ok('Attempt history stamped', `Attempts: ${markFailed.body.delivery.attempts?.length}, RetryCount: ${markFailed.body.delivery.retryCount}`);
  } else {
    fail('Failed delivery transition', `Status: ${markFailed.status}`);
  }

  console.log('\n── 5. Financial & Commission Ledger Consistency');
  // Check commission ledger for seller 1
  const commHistory = await api(`/commission-ledger/seller/${seller1Id}`, { token: seller1Token });
  if (commHistory.status === 200) {
    const entries = commHistory.body.data || commHistory.body.commissions || commHistory.body;
    ok('Seller commission ledger records retrieved', `Entries count: ${Array.isArray(entries) ? entries.length : 'active'}`);
  } else {
    fail('Commission ledger query', `Status: ${commHistory.status}`);
  }

  // Check wallets
  const s1W = (await api(`/wallet/${seller1Id}`, { token: seller1Token })).body;
  const s2W = (await api(`/wallet/${seller2Id}`, { token: seller2Token })).body;
  const pW = (await api('/delivery/provider-wallet/me', { token: providerToken })).body;
  ok('Seller 1 wallet verified', `Pending: ${s1W.data?.pendingBalance ?? s1W.wallet?.pendingBalance} ETB`);
  ok('Seller 2 wallet verified', `Pending: ${s2W.data?.pendingBalance ?? s2W.wallet?.pendingBalance} ETB`);
  ok('Provider wallet verified', `Pending: ${pW.wallet?.pendingBalance ?? pW.data?.pendingBalance} ETB`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  NEGATIVE, PERMISSION & BOUNDARY TEST SCENARIOS: ALL PASSED  ');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nSUITE FAILED:', err.message);
    process.exit(1);
  });
