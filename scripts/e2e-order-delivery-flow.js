#!/usr/bin/env node
'use strict';
/**
 * End-to-end marketplace flow against the RUNNING stack:
 *
 *   buyer (yihunebelay859@gmail.com)
 *     → adds REAL Ethiopian products from the seller (seller1@aritii.com) to the cart
 *     → checks out (COD, Harar City Zone)
 *   seller (seller1@aritii.com)
 *     → accepts (confirms) the order
 *   provider (provider@aritii.com)
 *     → is dispatched for the order, accepts it, picks the parcel up from the
 *       seller's shop, starts the customer leg and completes the delivery
 *
 * Every step — signing in, the catalogue, the cart, the checkout, the seller's
 * acceptance, the dispatch, the rider's pickup and the proof of delivery, and
 * every verification read — is a real PUBLIC API call against the API Gateway
 * (http://localhost:3000/api), the same endpoints the web portals use.
 *
 * The script NEVER writes to or reads from a database directly: no mongosh, no
 * psql, no direct model access. If a record cannot be reached through an
 * endpoint, the flow fails loudly instead of reaching around the API.
 *
 * Usage:
 *   node scripts/e2e-order-delivery-flow.js
 *
 * Environment overrides:
 *   GATEWAY_URL             default http://127.0.0.1:3000
 *   E2E_ADMIN_EMAIL/PASSWORD default admin@aritii.com / Admin@12345
 *   E2E_SELLER_EMAIL/PASSWORD default seller1@aritii.com / Seller@12345
 *   E2E_PROVIDER_EMAIL/PASSWORD default provider@aritii.com / provider123
 *   E2E_BUYER_EMAIL/PASSWORD default yihunebelay859@gmail.com / Buyer@12345
 *
 * The buyer account's password is whatever E2E_BUYER_PASSWORD says (the
 * platform's own reset path is PUT /api/user/update-user-password, which needs
 * the current password). The script only ever READS it through the API.
 */
const crypto = require('node:crypto');

const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BASE = `${GATEWAY}/api`;
const CLIENT_ID = 'aritii-admin-web';

const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com',
  password: process.env.E2E_ADMIN_PASSWORD || 'Admin@12345',
};
const SELLER = {
  email: process.env.E2E_SELLER_EMAIL || 'seller1@aritii.com',
  password: process.env.E2E_SELLER_PASSWORD || 'Seller@12345',
};
const PROVIDER = {
  email: process.env.E2E_PROVIDER_EMAIL || 'provider@aritii.com',
  password: process.env.E2E_PROVIDER_PASSWORD || 'provider123',
};
const BUYER = {
  email: process.env.E2E_BUYER_EMAIL || 'yihunebelay859@gmail.com',
  password: process.env.E2E_BUYER_PASSWORD || 'Buyer@12345',
};

// ── Reference data (seeded platform records) ────────────────────────────────
const ZONE = { id: '6ad38a4caad17c149c22346a', name: 'Harar City Zone' };
const LOCATION = {
  regionId: '6ad38a4baad17c149c22345b', regionName: 'Hararghe',
  cityId: '6ad38a4baad17c149c223464', cityName: 'Harar',
};
const SELLER_SHOP = {
  id: '6ad3f35539343c2e6f6053e7',
  name: 'Yihune Belay Sebsibe',
  address: 'Cheleleka, Harar, Ethiopia',
  phone: '+251913118455',
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
  additionalInstructions: 'Call the buyer on arrival — the gate is locked after 8pm.',
  coordinates: { latitude: 9.3126, longitude: 42.118 },
};

// Real Ethiopian catalogue for the seller's food shop (ETB).
const PRODUCTS = [
  {
    name: 'Yirgacheffe Coffee Beans 250g',
    category: 'Groceries & Food',
    description: 'Washed Yirgacheffe coffee from Gedeo Zone, harvested this season and roasted in Addis Ababa. Medium acidity with jasmine and bergamot notes.',
    discountPrice: 320,
    originalPrice: 380,
    stock: 60,
    quantity: 2,
    tags: 'coffee,yirgacheffe,ethiopian,roasted',
    sku: 'ARI-COF-YIR-250',
  },
  {
    name: 'Teff Flour (Genfo) 5kg Sack',
    category: 'Groceries & Food',
    description: 'Stone-milled teff from a family farm outside Harar. Authentic injera ingredient, finely ground and sifted, with no additives.',
    discountPrice: 450,
    originalPrice: 520,
    stock: 40,
    quantity: 1,
    tags: 'teff,genfo,injera,flour',
    sku: 'ARI-TEF-GEN-5K',
  },
  {
    name: 'Harar Wild Coffee Honey 500g',
    category: 'Groceries & Food',
    description: 'Raw wild-harvested coffee honey collected by bee-keepers in the Hararghe highlands. Dark, floral and unrefined.',
    discountPrice: 275,
    originalPrice: 310,
    stock: 35,
    quantity: 1,
    tags: 'honey,wild,coffee,harar',
    sku: 'ARI-HNY-WLD-500',
  },
  {
    name: 'Berbere Spice Blend 200g',
    category: 'Groceries & Food',
    description: 'Harar-style berbere blended with birdseye chilli, rue seed and korarima. Milder than the northern blend — good for shiro and firfir.',
    discountPrice: 95,
    originalPrice: 120,
    stock: 80,
    quantity: 2,
    tags: 'berbere,spice,harar,korarima',
    sku: 'ARI-BER-HAR-200',
  },
];

// ── Tiny HTTP client ────────────────────────────────────────────────────────
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

/** OIDC + PKCE sign-in: authorization code, then the token exchange. */
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

/**
 * Poll until `check` returns a truthy value or the budget runs out.
 */
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

/**
 * Sign in with the first password that works. API only — the script never
 * touches the identity database to make a session possible.
 */
async function loginAny(actor) {
  const attempts = [];
  for (const candidate of [actor.password, ...(actor.extraPasswords || [])]) {
    try {
      const token = await login(actor.email, candidate);
      return { token, used: candidate };
    } catch (err) {
      attempts.push(`"${candidate}" → ${err.message}`);
    }
  }
  const error = new Error(
    `Could not sign in as ${actor.email} through the API. Tried: ${attempts.join(' | ')}\n`
    + `Set ${actor.envVar} to the account's current password (the platform's own reset path is `
    + `PUT /api/user/update-user-password, which needs the old password).`,
  );
  error.code = 'LOGIN_FAILED';
  throw error;
}

async function main() {
  console.log(`Gateway: ${BASE}`);

  // ── 0. Sessions ───────────────────────────────────────────────────────────
  step('0. Sign in (OIDC + PKCE) as admin, seller, buyer and provider');
  const admin = await loginAny({ ...ADMIN, envVar: 'E2E_ADMIN_PASSWORD' });
  const adminToken = admin.token;
  ok('admin', ADMIN.email);
  const seller = await loginAny({ ...SELLER, envVar: 'E2E_SELLER_PASSWORD' });
  const sellerToken = seller.token;
  const sellerClaims = decodeClaims(sellerToken);
  ok('seller', `${SELLER.email} (capabilities: ${(sellerClaims.capabilities || []).join(', ')})`);
  const provider = await loginAny({ ...PROVIDER, envVar: 'E2E_PROVIDER_PASSWORD' });
  const providerToken = provider.token;
  const providerClaims = decodeClaims(providerToken);
  ok('provider', `${PROVIDER.email} (role=${providerClaims.role})`);
  const buyer = await loginAny({ ...BUYER, envVar: 'E2E_BUYER_PASSWORD' });
  const buyerToken = buyer.token;
  ok('buyer', `${BUYER.email}`);
  const buyerId = decodeClaims(buyerToken).sub || decodeClaims(buyerToken).id;
  const sellerId = sellerClaims.sub || sellerClaims.id;

  // ── 1. Platform configuration (admin) ─────────────────────────────────────
  step('1. Configure the Harar City Zone delivery fee (admin)');
  const zoneNow = assertOk(await api(`/delivery/zone/${ZONE.id}`, { token: adminToken }), 'get zone');
  const rules = zoneNow.zone.deliveryRules || {};
  const zoneUpdated = assertOk(await api(`/delivery/zone/${ZONE.id}`, {
    method: 'PUT',
    token: adminToken,
    body: {
      reason: 'E2E: publish the Harar City Zone price schedule',
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
  }), 'update zone');
  ok('zone fee schedule', JSON.stringify(zoneUpdated.zone.deliveryRules.quantityFees));

  step('2. Give the seller\'s shop a real pickup location (seller)');
  const shopUpdated = assertOk(await api('/shop/update-shop-info', {
    method: 'PUT',
    token: sellerToken,
    body: {
      shopId: SELLER_SHOP.id,
      name: SELLER_SHOP.name,
      description: 'Harar specialty foods — teff, berbere, wild coffee honey and coffee from Hararghe.',
      address: SELLER_SHOP.address,
      phoneNumber: SELLER_SHOP.phone,
      zipCode: '04',
      category: 'Food & Beverage',
      pickupEnabled: true,
      locationId: LOCATION.cityId,
    },
  }), 'update shop info');
  ok('shop location', JSON.stringify(shopUpdated.shop.locationSnapshot));

  step('3. Activate the shop\'s delivery coverage (admin)');
  const coverage = assertOk(await api(`/shop/admin/shops/${SELLER_SHOP.id}/coverage`, {
    method: 'PUT',
    token: adminToken,
    body: { zoneIds: [ZONE.id], status: 'ACTIVE' },
  }), 'set coverage');
  ok('coverage', `${coverage.shop.deliveryCoverage.status} → ${coverage.shop.deliveryCoverage.zoneNames.map((z) => z.name).join(', ')}`);

  // ── 2. Catalogue (seller) ─────────────────────────────────────────────────
  step('4. Publish the seller\'s Ethiopian catalogue (seller)');
  const shopCatalogue = assertOk(await api(`/product/get-all-products-shop/${SELLER_SHOP.id}`, { token: sellerToken }), 'shop catalogue');
  const existingByName = new Map((shopCatalogue.products || []).map((p) => [p.name, p]));
  const createdProducts = [];
  for (const product of PRODUCTS) {
    let existing = existingByName.get(product.name);
    if (existing) {
      const id = String(existing.id || existing._id);
      if (existing.status !== 'PUBLISHED') {
        assertOk(await api(`/product/publish/${id}`, { method: 'POST', token: sellerToken }), `publish(${product.name})`);
      }
      ok('reused', `${product.name} — ${existing.discountPrice} ETB`);
      createdProducts.push({ id, name: product.name, quantity: product.quantity, price: existing.discountPrice });
      continue;
    }
    const image = `https://ui-avatars.com/api/?name=${encodeURIComponent(product.name)}&background=b45309&color=fff&size=500`;
    const created = assertOk(await api('/product/create-product', {
      method: 'POST',
      token: sellerToken,
      body: {
        shopId: SELLER_SHOP.id,
        name: product.name,
        description: product.description,
        category: product.category,
        discountPrice: product.discountPrice,
        originalPrice: product.originalPrice,
        stock: product.stock,
        tags: product.tags,
        sku: `${product.sku}-${Date.now().toString().slice(-6)}`,
        imageUrls: [image],
      },
    }), `create-product(${product.name})`);
    const id = String(created.product.id || created.product._id);
    assertOk(await api(`/product/publish/${id}`, { method: 'POST', token: sellerToken }), `publish(${product.name})`);
    createdProducts.push({ id, name: product.name, quantity: product.quantity, price: product.discountPrice });
    ok('published', `${product.name} — ${product.discountPrice} ETB (${product.stock} in stock)`);
  }

  // ── 3. Cart + checkout (buyer) ────────────────────────────────────────────
  step('5. Buyer adds the products to the cart (buyer)');
  // Start from a clean cart so a re-run does not stack quantities.
  await api('/cart', { method: 'DELETE', token: buyerToken });
  for (const product of createdProducts) {
    const cart = assertOk(await api('/cart', {
      method: 'POST',
      token: buyerToken,
      body: {
        productId: product.id,
        quantity: product.quantity,
        zoneId: ZONE.id,
        zoneName: ZONE.name,
      },
    }), `add-to-cart(${product.name})`);
    ok('cart line', `${product.name} × ${product.quantity}`);
  }

  const validation = assertOk(await api('/cart/validate', {
    method: 'POST',
    token: buyerToken,
    body: { zoneId: ZONE.id, zoneName: ZONE.name },
  }), 'cart/validate');
  ok('cart zone validation', `valid=${validation.valid} (${validation.code || 'ok'})`);

  step('6. Buyer checks out with Cash On Delivery (buyer)');
  const orderResponse = assertOk(await api('/order/create-order', {
    method: 'POST',
    token: buyerToken,
    body: {
      cart: createdProducts.map((p) => ({ productId: p.id, quantity: p.quantity })),
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
  }), 'create-order');
  const order = orderResponse.orders[0];
  const orderId = String(order._id);
  ok('order created', `${orderId} — ${order.totalPrice} ETB (${order.items ? '' : ''}${order.cart.length} line(s), status=${order.status})`);

  const payment = assertOk(await api('/payment/create-payment', {
    method: 'POST',
    token: buyerToken,
    body: { orderId, paymentMethod: 'COD' },
  }), 'create-payment');
  ok('COD payment row', `${payment.payment.id || payment.payment._id} status=${payment.payment.status}`);

  // ── 4. Seller accepts ─────────────────────────────────────────────────────
  step('7. Seller accepts the order (seller)');
  let accepted = await api(`/order/${orderId}/confirm`, { method: 'POST', token: sellerToken });
  if (accepted.status >= 400) {
    console.log(`   · POST /order/:id/confirm → ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 200)}`);
    accepted = await api(`/order/${orderId}/status`, {
      method: 'PATCH',
      token: sellerToken,
      body: { status: 'Confirmed', reason: 'Seller accepted the order' },
    });
  }
  const acceptedBody = assertOk(accepted, 'seller accepts order');
  ok('order accepted', `status=${acceptedBody.order.status}`);

  // ── 5. Delivery handoff ───────────────────────────────────────────────────
  step('8. Wait for the Delivery Service to receive the order');
  const delivery = await waitFor(
    async () => {
      const res = await api(`/delivery/delivery/order/${orderId}`, { token: adminToken });
      return res.status === 200 ? res.body.delivery : null;
    },
    (value) => Boolean(value),
    { label: 'the delivery record' },
  );
  ok('delivery created', `${delivery.id || delivery._id} status=${delivery.status}`);

  // ── 6. Dispatch ───────────────────────────────────────────────────────────
  step('9. Dispatch: admin assigns the order to the provider (admin)');
  const providerMe = assertOk(await api('/delivery/provider/me', { token: providerToken }), 'provider/me');
  const providerId = String(providerMe.provider._id);
  ok('provider record', `${providerMe.provider.name} (${providerId}) status=${providerMe.provider.status}`);

  const ready = assertOk(await api('/delivery/dispatch/ready-orders', { token: adminToken }), 'ready-orders');
  const readyOrder = ready.orders.find((row) => String(row.orderId) === orderId);
  if (!readyOrder) throw new Error(`the order is not in the ready pool: ${JSON.stringify(ready.orders)}`);
  ok('ready for pickup', `${readyOrder.id} (${readyOrder.sellerName} → ${readyOrder.customer})`);

  const batch = assertOk(await api('/delivery/dispatch/batches', {
    method: 'POST',
    token: adminToken,
    body: {
      deliveryIds: [readyOrder.id],
      providerId,
      notes: 'E2E: Harar City Zone delivery',
    },
  }), 'create batch assignment');
  const batchId = String(batch.assignment.id || batch.assignment._id);
  ok('assignment created', `${batch.assignment.reference} (${batchId})`);

  // ── 7. Provider executes the delivery ─────────────────────────────────────
  step('10. Provider accepts the assignment (provider)');
  const responded = assertOk(await api(`/delivery/dispatch/batches/${batchId}/respond`, {
    method: 'POST',
    token: providerToken,
    body: { accepted: true },
  }), 'respond to batch');
  ok('assignment accepted', `status=${responded.assignment.status}`);

  step('11. Provider picks the parcel up from the seller (provider)');
  const picking = assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/start`, {
    method: 'POST',
    token: providerToken,
    body: {},
  }), 'pickup start');
  ok('pickup started', `status=${picking.assignment.status}`);

  const picked = assertOk(await api(`/delivery/dispatch/batches/${batchId}/pickup/${sellerId}/confirm`, {
    method: 'POST',
    token: providerToken,
    body: {},
  }), 'pickup confirm');
  ok('pickup confirmed', `stop=${picked.assignment.pickupPlan.map((s) => `${s.shopName || s.sellerName}:${s.completed}`).join(', ')}`);

  step('12. Provider starts the customer leg and completes the delivery (provider)');
  const transit = assertOk(await api(`/delivery/dispatch/batches/${batchId}/transit/start`, {
    method: 'POST',
    token: providerToken,
    body: {},
  }), 'transit start');
  ok('in transit', `status=${transit.assignment.status}`);

  const delivered = assertOk(await api(`/delivery/dispatch/batches/${batchId}/orders/${orderId}/deliver`, {
    method: 'POST',
    token: providerToken,
    body: {
      codConfirmed: true,
      codCollectedAmount: Number(order.totalPrice),
      recipientName: 'Yihune Belay Sebsibe',
      recipientReference: '+251911845533',
      type: 'confirmation',
      note: 'Cash collected on delivery, handed to the buyer at the gate.',
    },
  }), 'confirm delivery');
  ok('delivered', `batch status=${delivered.assignment.status}`);

  // ── 8. Verification (API reads only — no database access) ────────────────
  step('13. Verify the final state through the API');
  // The Delivery Service notifies Commerce ASYNCHRONOUSLY (status events are
  // queued and drained), so the order reaches "Delivered" a moment after the
  // rider confirms it.
  const finalOrder = await waitFor(
    async () => {
      const res = await api(`/order/order/${orderId}`, { token: adminToken });
      return res.status === 200 ? res.body.order : null;
    },
    (order_) => Boolean(order_) && order_.status === 'Delivered' && order_.paymentStatus === 'CONFIRMED',
    { label: 'the order to be delivered and paid' },
  );
  ok('order', `status=${finalOrder.status} payment=${finalOrder.paymentStatus} total=${finalOrder.totalPrice} ETB orderNumber=${finalOrder.orderNumber}`);
  ok('order items', finalOrder.cart.map((c) => `${c.name} × ${c.quantity}`).join(', '));

  // The BUYER sees the order in their own order list.
  const buyerOrders = assertOk(await api(`/order/get-all-orders/user/${buyerId}`, { token: buyerToken }), 'buyer order list');
  const buyerOrder = (buyerOrders.orders || []).find((o) => String(o._id) === orderId);
  ok('buyer order list', buyerOrder
    ? `found ${buyerOrder.orderNumber} — ${buyerOrder.status} / ${buyerOrder.paymentStatus} / ${buyerOrder.totalPrice} ETB`
    : 'NOT FOUND');
  if (!buyerOrder) throw new Error('the buyer cannot see the order in their own order list');

  // The SELLER sees it in the shop queue and in their own order list.
  const sellerOrders = assertOk(await api('/order/get-all-orders/seller/me', { token: sellerToken }), 'seller order list');
  const sellerOrder = (sellerOrders.orders || []).find((o) => String(o._id) === orderId);
  ok('seller order list', sellerOrder
    ? `found ${sellerOrder.orderNumber} — ${sellerOrder.status} / ${sellerOrder.paymentStatus}`
    : 'NOT FOUND');
  if (!sellerOrder) throw new Error('the seller cannot see the order in their own order list');
  const shopOrders = assertOk(await api(`/order/shop/${SELLER_SHOP.id}?page=1&limit=10`, { token: sellerToken }), 'shop order page');
  ok('seller shop queue', `${shopOrders.orders.length} order(s) on page 1, total ${shopOrders.total}`);

  // The PAYMENT is settled as cash-on-delivery.
  const paymentRow = assertOk(await api(`/payment/get-payment-by-order/${orderId}`, { token: buyerToken }), 'payment by order');
  ok('payment', `${paymentRow.payment.paymentMethod} ${paymentRow.payment.status} ${paymentRow.payment.amount} ETB`);

  // The DELIVERY carries the real addresses, the parcel and the COD proof.
  const finalDelivery = assertOk(await api(`/delivery/delivery/order/${orderId}`, { token: adminToken }), 'get delivery');
  ok('delivery', `status=${finalDelivery.delivery.status} rider=${finalDelivery.delivery.providerId}`);
  ok('pickup', `${finalDelivery.delivery.origin?.shopName}, ${finalDelivery.delivery.origin?.addressDetail} (${finalDelivery.delivery.origin?.cityName})`);
  ok('dropoff', `${finalDelivery.delivery.destination?.addressDetail}, ${finalDelivery.delivery.destination?.cityName} | zone=${finalDelivery.delivery.destination?.zoneId} | ${finalDelivery.delivery.destination?.contactPhone}`);
  ok('parcel', `${finalDelivery.delivery.itemCount} item(s), declared value ${finalDelivery.delivery.totalValue} ETB, fee ${finalDelivery.delivery.deliveryFee} ETB`);
  ok('COD proof', `${finalDelivery.delivery.proofOfDelivery?.codCollectedAmount} ETB collected by ${finalDelivery.delivery.proofOfDelivery?.recipientName}`);
  const history = assertOk(await api(`/delivery/delivery/${finalDelivery.delivery.id || finalDelivery.delivery._id}/history`, { token: adminToken }), 'delivery history');
  const historyStatuses = (history.trackingEvents || []).map((h) => h.stage || h.status);
  ok('delivery tracking', historyStatuses.length ? historyStatuses.join(' → ') : '(no tracking events recorded)');
  ok('delivery timeline', (history.timeline || []).map((t) => t.status || t.event).join(' → ') || '(empty)');

  // The RIDER sees the finished job in their own assignment list.
  const riderJobs = assertOk(await api('/delivery/dispatch/mine', { token: providerToken }), 'rider assignments');
  const riderJob = (riderJobs.assignments || []).find((b) => String(b._id) === batchId);
  ok('rider job list', riderJob
    ? `${riderJob.reference} — ${riderJob.status} (${riderJob.deliveries?.length || 0} order(s))`
    : 'NOT FOUND');
  if (!riderJob) throw new Error('the rider cannot see the assignment in their own job list');

  // The WALLETS: the seller's pending balance and the rider's earning.
  const sellerWallet = assertOk(await api(`/wallet/${sellerId}`, { token: sellerToken }), 'seller wallet');
  const walletRow = sellerWallet.data?.wallet || sellerWallet.wallet || sellerWallet.data || sellerWallet;
  ok('seller wallet', `pending ${walletRow.pendingBalance} ETB, available ${walletRow.availableBalance} ETB`);
  const riderWallet = assertOk(await api('/delivery/provider-wallet/me', { token: providerToken }), 'rider wallet');
  const riderRow = riderWallet.wallet || riderWallet.data?.wallet || riderWallet.data || riderWallet;
  ok('rider wallet', `pending ${riderRow.pendingBalance} ETB`);

  console.log('\n══ FLOW COMPLETE — every step ran through the API ══');
  console.log(`order      ${orderId} (${finalOrder.orderNumber})`);
  console.log(`items      ${createdProducts.map((p) => `${p.name} × ${p.quantity}`).join(', ')}`);
  console.log(`total      ${order.totalPrice} ETB (COD, collected on delivery)`);
  console.log(`zone       ${ZONE.name}`);
  console.log(`seller     ${SELLER.email} (shop ${SELLER_SHOP.id})`);
  console.log(`provider   ${PROVIDER.email} (${providerId})`);
  console.log(`assignment ${batch.assignment.reference} → ${batchId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
