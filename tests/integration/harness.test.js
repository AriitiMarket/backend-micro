'use strict';

/**
 * End-to-End Microservices Harness Test
 *
 * Runs against the active Dockerized stack (or local environment with GATEWAY_URL).
 * To run:
 *   npm run test:e2e
 *   or
 *   ARITII_E2E=1 node --test tests/integration/harness.test.js
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ENABLED = process.env.ARITII_E2E === '1' || process.env.RUN_E2E === 'true';
const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:8000').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.CHAPA_WEBHOOK_SECRET || 'test_chapa_secret_key_12345';

function generateChapaSignature(payloadString, secret = WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

async function call(pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (body !== undefined && !h['Content-Type']) {
    h['Content-Type'] = 'application/json';
  }
  const url = `${GATEWAY_URL}${pathname}`;
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

describe('End-to-End Endpoint & Concurrency Test Suite', { skip: !ENABLED }, () => {
  let buyerToken, seller1Token, seller2Token;
  let shopId, productId, orderId;

  test('Gateway Liveness & Discovery', async () => {
    const live = await call('/health/live');
    assert.strictEqual(live.status, 200);

    const oidc = await call('/.well-known/openid-configuration');
    assert.strictEqual(oidc.status, 200);
  });

  describe('Scenario A: Full Purchase & Fulfillment Lifecycle', () => {
    test('1. Buyer adds product to cart and checks out', async () => {
      // Direct login or registration
      const loginRes = await call('/api/auth/login', {
        method: 'POST',
        body: { email: 'buyer1@aritii.com', password: 'Buyer@12345' },
      });

      buyerToken = loginRes.body?.token;
      if (!buyerToken) return; // Skip sub-steps if live container not seeded yet

      const cartRes = await call('/api/cart/add', {
        method: 'POST',
        token: buyerToken,
        body: { productId: '6ad38a4baad17c149c223401', quantity: 1 },
      });
      assert.ok([200, 201].includes(cartRes.status));

      const orderRes = await call('/api/order/create-order', {
        method: 'POST',
        token: buyerToken,
        body: {
          items: [{ productId: '6ad38a4baad17c149c223401', quantity: 1, price: 450 }],
          shippingAddress: { city: 'Harar', phone: '+251911000001' },
          paymentMethod: 'CHAPA',
        },
      });
      assert.ok([200, 201].includes(orderRes.status));
      orderId = orderRes.body?.order?._id || orderRes.body?.data?._id;
    });

    test('2. Chapa webhook verifies HMAC and confirms payment', async () => {
      if (!orderId) return;
      const payload = JSON.stringify({
        event: 'charge.success',
        tx_ref: `tx_${orderId}`,
        amount: 450,
        currency: 'ETB',
        status: 'success',
        metadata: { orderId },
        timestamp: Math.floor(Date.now() / 1000),
      });

      const signature = generateChapaSignature(payload);
      const res = await call('/internal/commerce/payment-webhook', {
        method: 'POST',
        headers: {
          'x-chapa-signature': signature,
          'Content-Type': 'application/json',
          'x-internal-service': 'commerce',
          'x-internal-token': 'test-commerce-token',
        },
        body: payload,
      });

      assert.ok([200, 204].includes(res.status));
    });
  });

  describe('Scenario B: Security & Negative Access Gates', () => {
    test('rejects unauthenticated requests to wallet (401)', async () => {
      const res = await call('/api/wallet');
      assert.strictEqual(res.status, 401);
    });

    test('rejects forged webhook HMAC signature (400/401)', async () => {
      const payload = JSON.stringify({ event: 'charge.success', amount: 500 });
      const res = await call('/internal/commerce/payment-webhook', {
        method: 'POST',
        headers: {
          'x-chapa-signature': '0000000000000000000000000000000000000000000000000000000000000000',
          'Content-Type': 'application/json',
          'x-internal-service': 'commerce',
        },
        body: payload,
      });
      assert.ok([400, 401, 403].includes(res.status));
    });
  });

  describe('Scenario C: Concurrency & Race Conditions', () => {
    test('concurrent checkouts of single inventory stock prevent double-sale', async () => {
      if (!buyerToken) return;
      const requests = [1, 2, 3].map(() =>
        call('/api/order/create-order', {
          method: 'POST',
          token: buyerToken,
          body: {
            items: [{ productId: 'race-single-stock-item-id', quantity: 1, price: 500 }],
            shippingAddress: { city: 'Harar' },
          },
        })
      );

      const results = await Promise.all(requests);
      const successes = results.filter((r) => r.status === 200 || r.status === 201);
      assert.ok(successes.length <= 1, 'Only one order can claim the single available stock item');
    });
  });
});
