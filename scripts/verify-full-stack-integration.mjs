#!/usr/bin/env node
/**
 * Full-Stack Cross-Service & Frontend WebSocket Integration Verification
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const { io } = require(path.resolve(__dirname, '../../customer-frontend/node_modules/socket.io-client'));

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:8080').replace(/\/+$/, '');

// Load internal cluster tokens
function loadClusterTokens() {
  let raw = process.env.INTERNAL_SERVICE_TOKENS || '';
  if (!raw) {
    try {
      const envPath = path.resolve(__dirname, '../.env');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = /^\s*INTERNAL_SERVICE_TOKENS\s*=\s*(.+)$/m.exec(content);
        if (match) raw = match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } catch (_e) {}
  }
  try {
    if (raw.startsWith('{')) return JSON.parse(raw);
    const map = {};
    for (const pair of raw.split(',')) {
      const [k, v] = pair.split(':');
      if (k && v) map[k.trim()] = v.trim();
    }
    return map;
  } catch (_e) {
    return {};
  }
}

const TOKENS = loadClusterTokens();
const GATEWAY_TOKEN = TOKENS.gateway || 'test-gateway-token';
const COMMERCE_TOKEN = TOKENS.commerce || 'test-commerce-token';
const WEBHOOK_SECRET = process.env.CHAPA_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || 'chapa_webhook_secret_test_key_123';

let passedChecks = 0;
let totalChecks = 0;

async function check(name, fn) {
  totalChecks += 1;
  const start = Date.now();
  process.stdout.write(`  ⏳ ${name}... `);
  try {
    await fn();
    const duration = Date.now() - start;
    passedChecks += 1;
    console.log(`\x1b[32mPASSED\x1b[0m (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`\x1b[31mFAILED\x1b[0m (${duration}ms)`);
    console.error(`     \x1b[33mError: ${err.message}\x1b[0m`);
    throw err;
  }
}

async function call(pathname, { method = 'GET', body, token, internalService, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (internalService) {
    h['x-internal-service'] = internalService;
    h['x-internal-token'] = TOKENS[internalService] || (internalService === 'commerce' ? COMMERCE_TOKEN : GATEWAY_TOKEN);
  }
  if (body !== undefined && !h['Content-Type']) {
    h['Content-Type'] = 'application/json';
  }

  const url = pathname.startsWith('http') ? pathname : `${GATEWAY_URL}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: h,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_e) {
    parsed = text;
  }

  return { status: res.status, headers: res.headers, body: parsed };
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerAndLoginUser({ name, email, password, phone, role = 'BUYER' }) {
  const { verifier, challenge } = generatePKCE();
  const endpoint = role && role !== 'BUYER' ? `/api/auth/register/${role}` : '/api/auth/register';
  const regRes = await call(endpoint, {
    method: 'POST',
    body: {
      name,
      email,
      password,
      phoneNumber: phone || '+251911000001',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  });

  let code = regRes.body?.code || regRes.body?.data?.code;
  let userId = regRes.body?.user?.id || regRes.body?.data?.user?.id;

  if (code) {
    const tokenRes = await call('/api/auth/token', {
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      },
    });
    if (tokenRes.body?.access_token) {
      return { token: tokenRes.body.access_token, userId };
    }
  }

  // Fallback to authorize + token
  const authRes = await call('/api/auth/authorize', {
    method: 'POST',
    body: {
      client_id: 'aritii-eshop',
      email,
      password,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  });

  if (authRes.body?.code) {
    const tokenRes = await call('/api/auth/token', {
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code: authRes.body.code,
        code_verifier: verifier,
        client_id: 'aritii-eshop',
      },
    });
    return { token: tokenRes.body?.access_token, userId };
  }

  throw new Error(`Registration/Login failed: ${JSON.stringify(regRes.body || authRes.body)}`);
}

function generateChapaSignature(payloadString, secret = WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

async function run() {
  console.log('\n======================================================================');
  console.log('  ARITII MARKET — FULL-STACK INTEGRATION & WEBSOCKET VERIFICATION');
  console.log(`  Target Edge Gateway: ${GATEWAY_URL}`);
  console.log('======================================================================\n');

  console.log('======================================================================');
  console.log('  STEP 1: Gateway Proxy & Health Check Verification');
  console.log('======================================================================');

  await check('Verify Gateway edge health & downstream reachability', async () => {
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body?.status, 'healthy');
    assert.equal(res.body?.services?.identity?.ready, true);
    assert.equal(res.body?.services?.commerce?.ready, true);
    assert.equal(res.body?.services?.delivery?.ready, true);
  });

  await check('Verify OpenID Discovery and JWKS public key set endpoints', async () => {
    const oidcRes = await call('/api/.well-known/openid-configuration');
    assert.equal(oidcRes.status, 200);
    assert.ok(oidcRes.body?.jwks_uri);

    const jwksRes = await call('/api/auth/.well-known/jwks.json');
    assert.equal(jwksRes.status, 200);
    assert.ok(Array.isArray(jwksRes.body?.keys));
    assert.ok(jwksRes.body.keys.length > 0);
    assert.equal(jwksRes.body.keys[0].alg, 'RS256');
  });

  console.log('\n======================================================================');
  console.log('  STEP 2: Authentication & Role-Based API Contract Check');
  console.log('======================================================================');

  const stamp = Date.now();
  const buyerEmail = `int_buyer_${stamp}@aritii.com`;
  const buyerPassword = 'Password123!';
  let buyerAuth = null;
  let sampleProduct = null;

  await check('Register and Authenticate Buyer with PKCE authorization code grant', async () => {
    buyerAuth = await registerAndLoginUser({
      name: 'Integration Buyer',
      email: buyerEmail,
      password: buyerPassword,
      phone: '+251911999888',
      role: 'BUYER',
    });
    assert.ok(buyerAuth.token);
    assert.ok(typeof buyerAuth.token === 'string');

    // Decode JWT payload
    const parts = buyerAuth.token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    buyerAuth.userId = payload.sub || payload.userId || buyerAuth.userId;
    assert.ok(buyerAuth.userId, 'Authenticated JWT must contain a valid sub/userId');
  });

  await check('Buyer token authorizes access to /api/product/public/all and /api/cart', async () => {
    const pubProdRes = await call('/api/product/public/all');
    assert.ok([200, 204].includes(pubProdRes.status), `Public products failed: ${pubProdRes.status}`);
    assert.ok(Array.isArray(pubProdRes.body?.products) && pubProdRes.body.products.length > 0);
    sampleProduct = pubProdRes.body.products[0];

    const cartRes = await call('/api/cart', {
      token: buyerAuth.token,
    });
    assert.ok([200, 204].includes(cartRes.status), `Cart failed: ${cartRes.status}`);
  });

  await check('Zero-Trust / IDOR: Buyer token cannot access protected seller resources (401/403)', async () => {
    const sellerRes = await call('/api/wallet/dashboard', {
      token: buyerAuth.token,
    });
    assert.ok([401, 403].includes(sellerRes.status), `Expected 401/403 for unauthorized role, got ${sellerRes.status}`);
  });

  console.log('\n======================================================================');
  console.log('  STEP 3: Checkout, Chapa Payment Webhook & Wallet Settlement');
  console.log('======================================================================');

  let createdOrderId = null;
  let orderAmount = 450;

  await check('Buyer creates an order via Checkout flow (/api/order/create-order)', async () => {
    const checkoutRes = await call('/api/order/create-order', {
      method: 'POST',
      token: buyerAuth.token,
      body: {
        shippingAddress: {
          region: 'Hararghe',
          city: 'Harar',
          sector: 'Jugol',
          fullAddress: 'Main Gate, Harar Jugol',
          phone: '+251911000001',
        },
        paymentInfo: {
          type: 'CHAPA',
          status: 'PENDING',
        },
        cart: [
          {
            _id: sampleProduct._id,
            productId: sampleProduct._id,
            name: sampleProduct.name,
            quantity: 1,
            discountPrice: sampleProduct.discountPrice || 450,
            price: sampleProduct.originalPrice || 500,
            shopId: sampleProduct.shop?._id || sampleProduct.shopId,
          },
        ],
      },
    });

    assert.ok([200, 201].includes(checkoutRes.status), `Order creation failed: ${checkoutRes.status} ${JSON.stringify(checkoutRes.body)}`);
    createdOrderId = checkoutRes.body?.orders?.[0]?._id
      || checkoutRes.body?.order?._id
      || checkoutRes.body?.data?._id
      || checkoutRes.body?.orderId;
    orderAmount = checkoutRes.body?.orders?.[0]?.totalPrice || sampleProduct.discountPrice || 450;
    assert.ok(createdOrderId, 'Order ID must be returned from create-order');
  });

  await check('Verify Chapa Payment Webhook HMAC validation & idempotency', async () => {
    const testTxRef = `tx_${createdOrderId}_${stamp}`;
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      tx_ref: testTxRef,
      reference: `ref_${stamp}`,
      status: 'success',
      amount: orderAmount,
      currency: 'ETB',
      metadata: {
        orderId: createdOrderId,
      },
      timestamp: Math.floor(Date.now() / 1000),
    });

    const signature = generateChapaSignature(webhookPayload);

    // 1. Valid HMAC ingestion
    const res1 = await call('/internal/commerce/payment-webhook', {
      method: 'POST',
      internalService: 'commerce',
      headers: {
        'x-chapa-signature': signature,
        'Content-Type': 'application/json',
      },
      body: webhookPayload,
    });
    assert.ok([200, 204].includes(res1.status), `Webhook ingestion expected 200/204, got ${res1.status}: ${JSON.stringify(res1.body)}`);

    // 2. Idempotent duplicate delivery
    const res2 = await call('/internal/commerce/payment-webhook', {
      method: 'POST',
      internalService: 'commerce',
      headers: {
        'x-chapa-signature': signature,
        'Content-Type': 'application/json',
      },
      body: webhookPayload,
    });
    assert.ok([200, 204].includes(res2.status), `Idempotent duplicate webhook expected 200/204, got ${res2.status}`);

    // 3. Rejection of tampered / invalid HMAC signature
    const badSigRes = await call('/internal/commerce/payment-webhook', {
      method: 'POST',
      internalService: 'commerce',
      headers: {
        'x-chapa-signature': '0000000000000000000000000000000000000000000000000000000000000000',
        'Content-Type': 'application/json',
      },
      body: webhookPayload,
    });
    assert.ok([400, 401].includes(badSigRes.status), `Forged HMAC signature must be rejected, got ${badSigRes.status}`);
  });

  console.log('\n======================================================================');
  console.log('  STEP 4: Real-Time WebSocket Handshake & Event Streaming');
  console.log('======================================================================');

  await check('Socket.IO authenticated handshake & room event reception', async () => {
    const socket = io(GATEWAY_URL, {
      auth: { token: buyerAuth.token },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 5000,
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error('Socket.IO handshake timed out'));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });

      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(socket.connected);
    assert.ok(socket.id);

    // Subscribe to a test product request room
    const testRequestId = `req_${stamp}`;
    socket.emit('request:subscribe', { requestIds: [testRequestId] });

    // Wait for event via internal realtime fan-out
    const eventReceivedPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Real-time event fanout timed out'));
      }, 5000);

      socket.on('request:event', (event) => {
        if (event?.requestId === testRequestId) {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });

    // Gateway internal emit
    const emitRes = await call('/internal/realtime/emit', {
      method: 'POST',
      internalService: 'gateway',
      body: {
        type: 'request.event.created',
        requestId: testRequestId,
        recipients: [buyerAuth.userId],
        actorId: 'admin_sys',
        data: { message: 'Order status updated to dispatched' },
      },
    });
    assert.ok([200, 204].includes(emitRes.status), `Internal emit failed with status ${emitRes.status}: ${JSON.stringify(emitRes.body)}`);

    const receivedEvent = await eventReceivedPromise;
    assert.equal(receivedEvent.requestId, testRequestId);
    assert.equal(receivedEvent.type, 'request.event.created');

    socket.disconnect();
  });

  console.log('\n======================================================================');
  console.log('  INTEGRATION VERIFICATION SUMMARY');
  console.log('======================================================================');
  console.log(`  Total Checks: ${totalChecks}`);
  console.log(`  Passed:       ${passedChecks}`);
  console.log(`  Failed:       0`);
  console.log('======================================================================\n');
  console.log('✓ Full-stack integration & real-time WebSocket sync verified successfully.\n');
}

run().catch((err) => {
  console.error('\n✖ Integration verification failed:', err);
  process.exit(1);
});
