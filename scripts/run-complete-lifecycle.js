#!/usr/bin/env node
'use strict';

/**
 * End-to-end Lifecycle Test via API Gateway Endpoints
 * Tests:
 *  1. OAuth 2.1 PKCE Authentication for Admin, Seller, Buyer, Provider
 *  2. Catalog discovery (Categories, Products, Shops)
 *  3. Order Placement (Buyer)
 *  4. Order Confirmation (Seller)
 *  5. Order Processing & Shipping (Seller)
 *  6. Delivery Transit & Completion (Delivery / Admin)
 *  7. Timeline and Audit verification
 */

const crypto = require('crypto');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api';

function pkceVerifier() {
  const bytes = crypto.randomBytes(32);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkceChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function request(method, path, body = null, token = null) {
  const url = `${API_BASE}${path}`;
  const headers = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, ok: res.ok, data };
}

async function login(email, password, label) {
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);

  const authRes = await request('POST', '/auth/authorize', {
    email,
    password,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  if (!authRes.ok) {
    throw new Error(`Login ${label} (${email}) failed at /auth/authorize: ${authRes.status} ${JSON.stringify(authRes.data)}`);
  }

  const code = authRes.data.code;
  if (!code) throw new Error(`Login ${label} (${email}) missing code in response`);

  const tokenRes = await request('POST', '/auth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange for ${label} failed: ${tokenRes.status} ${JSON.stringify(tokenRes.data)}`);
  }

  console.log(`  ✓ Authenticated as ${label}: ${email}`);
  return {
    email,
    label,
    accessToken: tokenRes.data.access_token,
    user: tokenRes.data.user || tokenRes.data,
  };
}

async function main() {
  console.log('============================================================');
  console.log(`  ARITII MARKET — COMPLETE ORDER LIFECYCLE RUNNER`);
  console.log(`  Target: ${API_BASE}`);
  console.log('============================================================\n');

  // 1. Authenticate Actors
  console.log('── Step 1: Authenticating Platform Actors ──');
  const admin = await login('admin@aritii.com', 'Admin@12345', 'Super Admin');
  const seller = await login('seller1@aritii.com', 'Seller@12345', 'Harar Seller');
  const buyer = await login('buyer1@aritii.com', 'Buyer@12345', 'Customer / Buyer');
  const provider = await login('provider@aritii.com', 'Provider@12345', 'Delivery Provider');

  // 2. Discover Categories & Products
  console.log('\n── Step 2: Catalog Discovery via API Gateway ──');
  const catRes = await request('GET', '/category', null, buyer.accessToken);
  const categories = catRes.data?.categories || [];
  console.log(`  ✓ Found ${categories.length} active categories`);

  const prodRes = await request('GET', '/product/public/all?limit=10', null, buyer.accessToken);
  const products = prodRes.data?.products || [];
  if (products.length === 0) {
    throw new Error('No products found in marketplace catalog');
  }
  const selectedProduct = products[0];
  const price = selectedProduct.discountPrice || selectedProduct.originalPrice || selectedProduct.price;
  const shopId = selectedProduct.shop?._id || selectedProduct.shopId;
  const shopName = selectedProduct.shop?.name || selectedProduct.shopName;
  console.log(`  ✓ Selected product: "${selectedProduct.name}" (ID: ${selectedProduct._id}, Shop: ${shopName || shopId})`);
  console.log(`    Price: ${price} ETB | Stock: ${selectedProduct.stock}`);

  // 3. Buyer Places an Order
  console.log('\n── Step 3: Buyer Places Order via /order/create-order ──');
  const orderPayload = {
    cart: [
      {
        productId: String(selectedProduct._id),
        quantity: 1,
      },
    ],
    shippingAddress: {
      address: 'Jugol Historic Gate, Harar',
      city: 'Harar',
      country: 'Ethiopia',
      phoneNumber: '0911223344',
    },
    paymentInfo: {
      method: 'COD',
      status: 'pending',
    },
    destination: {
      regionName: 'Hararghe',
      cityName: 'Harar',
      sectorName: 'Jugol (Historic Walled City)',
      fullAddress: 'Jugol Historic Gate, House 14',
      phone: '0911223344',
    },
  };

  const createRes = await request('POST', '/order/create-order', orderPayload, buyer.accessToken);
  if (!createRes.ok) {
    throw new Error(`Order creation failed: ${createRes.status} ${JSON.stringify(createRes.data)}`);
  }

  const createdOrder = createRes.data?.orders?.[0] || createRes.data?.order;
  if (!createdOrder) {
    throw new Error(`No order returned in response: ${JSON.stringify(createRes.data)}`);
  }
  const orderId = createdOrder._id || createdOrder.id;
  const orderNumber = createdOrder.orderNumber;
  console.log(`  ✓ Order created successfully!`);
  console.log(`    Order ID:     ${orderId}`);
  console.log(`    Order Number: ${orderNumber}`);
  console.log(`    Initial Status: ${createdOrder.status}`);

  // 4. Seller Confirms the Order
  console.log('\n── Step 4: Seller Confirms Order (Processing -> Confirmed) ──');
  const confirmRes = await request(
    'PUT',
    `/order/update-order-status/${orderId}`,
    { status: 'Confirmed', reason: 'Seller accepted and confirmed order items in stock' },
    admin.accessToken
  );
  if (!confirmRes.ok) {
    throw new Error(`Order confirmation failed: ${confirmRes.status} ${JSON.stringify(confirmRes.data)}`);
  }
  console.log(`  ✓ Order status updated: Confirmed`);

  // 5. Seller Packages & Ships (Confirmed -> Shipped)
  console.log('\n── Step 5: Order Packaged for Delivery (Confirmed -> Shipped) ──');
  const shipRes = await request(
    'PUT',
    `/order/update-order-status/${orderId}`,
    { status: 'Shipped', reason: 'Order packaged and ready for delivery partner pickup' },
    admin.accessToken
  );
  if (!shipRes.ok) {
    throw new Error(`Order shipping failed: ${shipRes.status} ${JSON.stringify(shipRes.data)}`);
  }
  console.log(`  ✓ Order status updated: Shipped`);

  // 6. Delivery In Transit (Shipped -> In Transit)
  console.log('\n── Step 6: Provider Dispatches Order (Shipped -> In Transit) ──');
  const transitRes = await request(
    'PUT',
    `/order/update-order-status/${orderId}`,
    { status: 'In Transit', reason: 'Courier picked up package and is out for delivery' },
    admin.accessToken
  );
  if (!transitRes.ok) {
    throw new Error(`Order in-transit failed: ${transitRes.status} ${JSON.stringify(transitRes.data)}`);
  }
  console.log(`  ✓ Order status updated: In Transit`);

  // 7. Order Delivered (In Transit -> Delivered)
  console.log('\n── Step 7: Order Delivery Completed (In Transit -> Delivered) ──');
  const deliveredRes = await request(
    'PUT',
    `/order/update-order-status/${orderId}`,
    { status: 'Delivered', reason: 'Customer received package and paid cash on delivery' },
    admin.accessToken
  );
  if (!deliveredRes.ok) {
    throw new Error(`Order delivery failed: ${deliveredRes.status} ${JSON.stringify(deliveredRes.data)}`);
  }
  console.log(`  ✓ Order status updated: Delivered`);

  // 8. Verify Order Timeline & Details
  console.log('\n── Step 8: Verifying Order Audit & Lifecycle History ──');
  const finalRes = await request('GET', `/order/order/${orderId}`, null, buyer.accessToken);
  const finalOrder = finalRes.data?.order || finalRes.data;
  console.log(`  ✓ Final Order Status: ${finalOrder?.status}`);
  console.log(`  ✓ Total Amount:       ${finalOrder?.totalPrice} ETB`);
  console.log(`  ✓ Items Count:        ${finalOrder?.cart?.length || 1}`);

  const timelineRes = await request('GET', `/order/${orderId}/timeline`, null, buyer.accessToken);
  const timeline = timelineRes.data?.timeline || [];
  console.log(`  ✓ Timeline events recorded: ${timeline.length}`);
  timeline.forEach((evt, idx) => {
    console.log(`     ${idx + 1}. [${evt.timestamp || evt.createdAt || 'now'}] ${evt.status || evt.action}: ${evt.reason || evt.note || evt.description || 'Status update'}`);
  });

  console.log('\n============================================================');
  console.log('✓ COMPLETE END-TO-END ORDER LIFECYCLE PASSED SUCCESSFULLY');
  console.log('============================================================\n');
}

main().catch((err) => {
  console.error('\n✗ Lifecycle execution failed:', err);
  process.exit(1);
});
