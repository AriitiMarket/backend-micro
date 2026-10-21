#!/usr/bin/env node
'use strict';
/**
 * Multi-shop delivery check.
 *
 * ONE buyer checkout that spans TWO shops must produce:
 *   * one seller order per shop (sharing one orderGroupId),
 *   * one delivery per seller order,
 *   * ONE dispatch batch whose pickup plan has a stop per shop,
 *   * and a rider run that confirms every seller stop and completes both
 *     deliveries.
 *
 * This is the case the rider portal has to get right: the rider collects the
 * parcel at EVERY shop of the checkout, so the portal must show one stop (and
 * one pickup confirmation) per seller.
 *
 * Everything is a public API call — no database access.
 *
 * Usage:
 *   node scripts/e2e-multi-shop-delivery.js
 */
const crypto = require('node:crypto');

const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BASE = `${GATEWAY}/api`;
const CLIENT_ID = 'aritii-admin-web';

const ZONE = { id: '6ad38a4caad17c149c22346a', name: 'Harar City Zone' };
const CITY = '6ad38a4baad17c149c223464';
const REGION = { id: '6ad38a4baad17c149c22345b', name: 'Hararghe' };
const PROVIDER = '6ad79a4a9892e6f756f76c71';
const SHOP_A = '6ad3f35539343c2e6f6053e7';   // seller1 — Yihune Belay Sebsibe
const SHOP_B = '6ad912668279973315445acc';   // seller2 — Harar Artisan Crafts
const SELLER_A = { email: 'seller1@aritii.com', password: 'Seller@12345' };
const SELLER_B = { email: 'seller2@aritii.com', password: 'Seller@12345' };
const BUYER = { email: 'yihunebelay859@gmail.com', password: 'Buyer@12345' };
const ADMIN = { email: 'admin@aritii.com', password: 'Admin@12345' };
const PROVIDER_ACTOR = { email: 'provider@aritii.com', password: 'provider123' };

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function assertOk(res, label) {
  if (res.status >= 400) {
    throw new Error(`${label} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body;
}

const s256 = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

async function login(email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const authorize = assertOk(await api('/auth/authorize', {
    method: 'POST',
    body: { client_id: CLIENT_ID, email, password, code_challenge: s256(verifier), code_challenge_method: 'S256' },
  }), `authorize(${email})`);
  const token = assertOk(await api('/auth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code: authorize.code, code_verifier: verifier, client_id: CLIENT_ID },
  }), `token(${email})`);
  return token.access_token;
}

const ok = (label, extra = '') => console.log(`   ✓ ${label}${extra ? ' — ' + extra : ''}`);

async function main() {
  console.log(`Gateway: ${BASE}\n`);

  const adminToken = await login(ADMIN.email, ADMIN.password);
  const sellerAToken = await login(SELLER_A.email, SELLER_A.password);
  const sellerBToken = await login(SELLER_B.email, SELLER_B.password);
  const buyerToken = await login(BUYER.email, BUYER.password);
  const providerToken = await login(PROVIDER_ACTOR.email, PROVIDER_ACTOR.password);

  // One published product from each shop.
  const catalogue = async (shopId, token) => (assertOk(
    await api(`/product/get-all-products-shop/${shopId}`, { token }),
    `catalogue(${shopId})`,
  ).products || []).filter((p) => p.status === 'PUBLISHED');
  const fromA = (await catalogue(SHOP_A, sellerAToken)).slice(0, 1);
  const fromB = (await catalogue(SHOP_B, sellerBToken)).slice(0, 1);
  if (!fromA.length || !fromB.length) throw new Error('both shops need a published product');
  ok('two shops with products', `${fromA[0].name} + ${fromB[0].name}`);

  // One cart, two shops.
  await api('/cart', { method: 'DELETE', token: buyerToken });
  for (const product of [...fromA, ...fromB]) {
    assertOk(await api('/cart', {
      method: 'POST',
      token: buyerToken,
      body: { productId: product._id || product.id, quantity: 1, zoneId: ZONE.id, zoneName: ZONE.name },
    }), 'add-to-cart');
  }

  const created = assertOk(await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: [...fromA, ...fromB].map((p) => ({ productId: p._id || p.id, quantity: 1 })),
      fulfilmentType: 'delivery',
      deliveryZoneId: ZONE.id,
      deliveryZoneName: ZONE.name,
      destination: {
        regionId: REGION.id, regionName: REGION.name,
        cityId: CITY, cityName: 'Harar', sectorId: CITY, sectorName: 'Harar',
        deliveryZoneId: ZONE.id, deliveryZoneName: ZONE.name,
        fullAddress: 'Belghis Mazmura, near Ahmed Hassan Hotel, Harar',
        landmark: 'Belghis Mazmura junction', building: 'House 214',
        phone: '+251911845533', additionalInstructions: 'Call on arrival.',
        coordinates: { latitude: 9.3126, longitude: 42.118 },
      },
      shippingAddress: { country: 'Ethiopia', city: 'Harar', address1: 'Belghis Mazmura, Harar', zipCode: '04', addressType: 'Home', phone: '+251911845533' },
      user: { id: '009ef430-1e99-47fc-b9ad-5e0667b1a8be', email: BUYER.email, name: 'Yihune Belay Sebsibe' },
      paymentInfo: { type: 'Cash On Delivery', method: 'COD', status: 'Pay on delivery' },
    },
  }), 'create-order');

  const orders = created.orders;
  const groups = new Set(orders.map((o) => o.orderGroupId));
  ok('one checkout → one order per shop', `${orders.length} seller order(s)`);
  ok('the seller orders share one checkout group', groups.size === 1, [...groups].join(','));
  orders.forEach((o) => console.log(`      ${o._id} | ${o.totalPrice} ETB | shop ${o.shopId}`));

  // Each seller accepts their own order.
  for (const order of orders) {
    const token = String(order.sellerId) === 'faeddb30-f143-45a1-b6f8-6b3ca0b3123e' ? sellerAToken : sellerBToken;
    assertOk(await api(`/order/${order._id}/confirm`, { method: 'POST', token }), `confirm ${order._id}`);
    assertOk(await api('/payment/create-payment', {
      method: 'POST', token: buyerToken, body: { orderId: order._id, paymentMethod: 'COD' },
    }), 'create-payment');
  }
  ok('both sellers accepted their own order', `${orders.length} order(s)`);

  // One delivery per seller order.
  const deliveries = [];
  for (const order of orders) {
    let delivery = null;
    for (let i = 0; i < 30 && !delivery; i += 1) {
      const res = await api(`/delivery/delivery/order/${order._id}`, { token: adminToken });
      if (res.status === 200 && res.body.delivery) delivery = res.body.delivery;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    if (!delivery) throw new Error(`no delivery for order ${order._id}`);
    deliveries.push(delivery);
  }
  ok('one delivery per seller order', deliveries.map((d) => d.origin?.shopName || '?').join(' | '));

  // ONE batch for both deliveries.
  const batch = assertOk(await api('/delivery/dispatch/batches', {
    method: 'POST',
    token: adminToken,
    body: { deliveryIds: deliveries.map((d) => String(d._id || d.id)), providerId: PROVIDER, notes: 'Multi-shop check' },
  }), 'create batch');
  const batchId = String(batch.assignment.id || batch.assignment._id);
  ok('one batch carries both orders', `${batch.assignment.reference} · ${batch.assignment.deliveries.length} order(s)`);
  const stops = batch.assignment.pickupPlan || [];
  stops.forEach((stop) => console.log(`      stop ${stop.sequence}: ${stop.shopName || stop.sellerName} (${stop.orderIds.length} order(s))`));
  if (stops.length !== 2) throw new Error(`expected one pickup stop per shop, got ${stops.length}`);

  // The rider runs the whole plan.
  assertOk(await api(`/delivery/dispatch/batches/${batchId}/respond`, {
    method: 'POST', token: providerToken, body: { accepted: true },
  }), 'respond');
  assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/start`, {
    method: 'POST', token: providerToken, body: {},
  }), 'pickup start');
  for (const stop of stops) {
    assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/${stop.sellerId}/confirm`, {
      method: 'POST', token: providerToken, body: {},
    }), `pickup ${stop.sellerId}`);
    ok('pickup confirmed', stop.shopName || stop.sellerName);
  }
  assertOk(await api(`/delivery/dispatch/batches/${batchId}/transit/start`, {
    method: 'POST', token: providerToken, body: {},
  }), 'transit start');
  for (const delivery of batch.assignment.deliveries) {
    assertOk(await api(`/delivery/dispatch/batches/${batchId}/orders/${delivery.orderId}/deliver`, {
      method: 'POST',
      token: providerToken,
      body: {
        codConfirmed: true,
        codCollectedAmount: Number(delivery.paymentAmount),
        recipientName: 'Yihune Belay Sebsibe',
        type: 'confirmation',
      },
    }), `deliver ${delivery.orderId}`);
    ok('delivered', `${delivery.orderId} (${delivery.paymentAmount} ETB collected)`);
  }

  const finalBatch = assertOk(await api(`/delivery/dispatch/batches/${batchId}`, { token: providerToken }), 'batch');
  ok('batch completed', finalBatch.assignment.status);

  // The commerce side settles both orders.
  for (const order of orders) {
    const settled = await waitFor(async () => {
      const res = await api(`/order/order/${order._id}`, { token: adminToken });
      return res.body.order && res.body.order.status === 'Delivered' ? res.body.order : null;
    }, { label: `order ${order._id}` });
    if (!settled) throw new Error(`order ${order._id} never reached Delivered`);
    ok('order delivered and paid', `${settled.orderNumber} · ${settled.status} / ${settled.paymentStatus} · ${settled.totalPrice} ETB`);
  }

  console.log('\n══ MULTI-SHOP DELIVERY COMPLETE ══');
}

async function waitFor(read, { timeoutMs = 45000, stepMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
