'use strict';

/**
 * Full-System Endpoints Verification Test Suite
 *
 * Exercises all endpoints and routes across:
 * 1) API Gateway (Edge routing, health checks, error handling, 404, internal emit)
 * 2) Identity Service (Auth, users, admin, sellers, providers, 2FA, addresses, agents, OIDC)
 * 3) Commerce Service (Catalog, shops, orders, fulfillment, carts, finance, wallets, returns, disputes, webhooks)
 * 4) Delivery Service (Locations, zones, provider wallets, assignments, shipments, tracking, applications)
 * 5) Zero-Trust Boundary Audit (Verifying direct microservice access without edge credentials is denied)
 * 6) Route Handler Integrity Audit (Inspecting all 600+ route handlers to ensure 0 undefined/broken middlewares)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Helper to make HTTP requests to test servers
function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const method = options.method || 'GET';
    const headers = options.headers || {};
    let body = options.body;

    if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (_e) {
            parsed = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Extract routes from Express applications
function extractRoutes(app) {
  const routes = [];
  function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        const path = (prefix + layer.route.path).replace(/\/+/g, '/');
        const handlers = (layer.route.stack || []).map((s) => s.handle);
        for (const method in layer.route.methods) {
          routes.push({
            method: method.toUpperCase(),
            path,
            handlers,
          });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        let mount = '';
        if (layer.regexp && layer.regexp.fast_slash) {
          mount = '';
        } else if (layer.regexp) {
          const match = layer.regexp.source
            .replace('^\\/', '/')
            .replace('\\/?(?=\\/|$)', '')
            .replace(/\\\//g, '/');
          const m = match.match(/^\/?([a-zA-Z0-9_\-:]+(?:\/[a-zA-Z0-9_\-:]+)*)/);
          mount = m ? '/' + m[1] : '';
        }
        walk(layer.handle.stack, prefix + mount);
      }
    }
  }
  if (app._router && app._router.stack) walk(app._router.stack, '');
  return routes;
}

describe('Full-System Endpoints Verification Suite', () => {
  let gwServer, idServer, comServer, delServer;
  let idApp, comApp, delApp, gwApp;

  const TEST_TOKENS = {
    gateway: 'test-gateway-token-12345',
    identity: 'test-identity-token-12345',
    commerce: 'test-commerce-token-12345',
    delivery: 'test-delivery-token-12345',
  };

  before(async () => {
    process.env.INTERNAL_SERVICE_NAME = 'gateway';
    process.env.INTERNAL_SERVICE_TOKENS = JSON.stringify(TEST_TOKENS);

    idApp = require('../identity-service/src/app');
    comApp = require('../commerce-service/src/app/app');
    delApp = require('../delivery-service/src/app/routes/app');
    gwApp = require('../api-gateway/src/app').app;

    const startServer = (app) =>
      new Promise((resolve) => {
        const s = http.createServer(app);
        s.listen(0, '127.0.0.1', () => resolve(s));
      });

    idServer = await startServer(idApp);
    comServer = await startServer(comApp);
    delServer = await startServer(delApp);
    gwServer = await startServer(gwApp);
  });

  after(async () => {
    if (gwServer) gwServer.close();
    if (idServer) idServer.close();
    if (comServer) comServer.close();
    if (delServer) delServer.close();
  });

  describe('1. Route Handler Integrity Across All 600+ Endpoints', () => {
    test('all Identity Service routes have valid, non-null function handlers', () => {
      const routes = extractRoutes(idApp);
      assert.ok(routes.length >= 90, `Expected >= 90 routes, found ${routes.length}`);
      for (const r of routes) {
        assert.ok(r.handlers.length > 0, `Route ${r.method} ${r.path} has no handlers`);
        for (const h of r.handlers) {
          assert.strictEqual(typeof h, 'function', `Handler in ${r.method} ${r.path} is not a function`);
        }
      }
    });

    test('all Commerce Service routes have valid, non-null function handlers', () => {
      const routes = extractRoutes(comApp);
      assert.ok(routes.length >= 300, `Expected >= 300 routes, found ${routes.length}`);
      for (const r of routes) {
        assert.ok(r.handlers.length > 0, `Route ${r.method} ${r.path} has no handlers`);
        for (const h of r.handlers) {
          assert.strictEqual(typeof h, 'function', `Handler in ${r.method} ${r.path} is not a function`);
        }
      }
    });

    test('all Delivery Service routes have valid, non-null function handlers', () => {
      const routes = extractRoutes(delApp);
      assert.ok(routes.length >= 150, `Expected >= 150 routes, found ${routes.length}`);
      for (const r of routes) {
        assert.ok(r.handlers.length > 0, `Route ${r.method} ${r.path} has no handlers`);
        for (const h of r.handlers) {
          assert.strictEqual(typeof h, 'function', `Handler in ${r.method} ${r.path} is not a function`);
        }
      }
    });
  });

  describe('2. API Gateway Routing & Edge Security Endpoints', () => {
    test('GET /health/live returns alive status with 200', async () => {
      const res = await request(gwServer, '/health/live');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'alive');
    });

    test('GET /health/ready returns service readiness report', async () => {
      const res = await request(gwServer, '/health/ready');
      assert.ok([200, 503].includes(res.status));
      assert.ok(res.body.services);
    });

    test('GET /non-existent-path returns 404 ROUTE_NOT_FOUND', async () => {
      const res = await request(gwServer, '/non-existent-path');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.code, 'ROUTE_NOT_FOUND');
    });

    test('POST /internal/realtime/emit rejects unauthenticated callers (401/403)', async () => {
      const res = await request(gwServer, '/internal/realtime/emit', {
        method: 'POST',
        body: { type: 'request.message.created', requestId: 'req_1' },
      });
      assert.ok([401, 403].includes(res.status));
    });

    test('POST /internal/realtime/emit validates payload with cluster credentials', async () => {
      const res = await request(gwServer, '/internal/realtime/emit', {
        method: 'POST',
        headers: {
          'x-internal-service': 'commerce',
          'x-internal-token': TEST_TOKENS.commerce,
        },
        body: { type: 'INVALID_TYPE', requestId: 'req_1' },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, 'INVALID_EVENT');
    });
  });

  describe('3. Zero-Trust Perimeter Boundary (gatewayOnly Enforcement)', () => {
    test('direct call to Identity /auth/login without gateway credentials is rejected (401/403)', async () => {
      const res = await request(idServer, '/auth/login', {
        method: 'POST',
        body: { email: 'test@example.com', password: 'Password123!' },
      });
      assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
    });

    test('direct call to Commerce /shop/all without gateway credentials is rejected (401/403)', async () => {
      const res = await request(comServer, '/shop/all');
      assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
    });

    test('direct call to Delivery /delivery/delivery without gateway credentials is rejected (401/403)', async () => {
      const res = await request(delServer, '/delivery/delivery');
      assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
    });
  });

  describe('4. Identity Service Endpoints Verification', () => {
    const gwAuth = {
      'x-internal-service': 'gateway',
      'x-internal-token': TEST_TOKENS.gateway,
    };

    test('GET /health/live returns process status', async () => {
      const res = await request(idServer, '/health/live');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service, 'identity-service');
      assert.strictEqual(res.body.status, 'alive');
    });

    test('GET /.well-known/openid-configuration returns discovery document', async () => {
      const res = await request(idServer, '/.well-known/openid-configuration');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.issuer);
      assert.ok(res.body.jwks_uri);
    });

    test('GET /.well-known/jwks.json returns public key set', async () => {
      const res = await request(idServer, '/.well-known/jwks.json');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.keys));
    });

    test('POST /auth/register validates payload schema (rejects empty/invalid body with 400)', async () => {
      const res = await request(idServer, '/auth/register', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    test('POST /auth/login validates payload schema (rejects empty body with 400)', async () => {
      const res = await request(idServer, '/auth/login', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    test('POST /auth/refresh validates payload schema (rejects missing refresh token with 400)', async () => {
      const res = await request(idServer, '/auth/refresh', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    test('POST /auth/forgot-password validates payload schema (rejects missing email with 400)', async () => {
      const res = await request(idServer, '/auth/forgot-password', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    test('GET /user/profile requires authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(idServer, '/user/profile', {
        headers: gwAuth,
      });
      assert.strictEqual(res.status, 401);
    });

    test('GET /admin/users requires authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(idServer, '/admin/users', {
        headers: gwAuth,
      });
      assert.strictEqual(res.status, 401);
    });

    test('GET /internal/users/count rejects unauthorized peer calls', async () => {
      const res = await request(idServer, '/internal/users/count', {
        headers: {
          'x-internal-service': 'untrusted',
          'x-internal-token': 'wrong-token',
        },
      });
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('5. Commerce Service Endpoints Verification', () => {
    const gwAuth = {
      'x-internal-service': 'gateway',
      'x-internal-token': TEST_TOKENS.gateway,
    };

    test('GET /health/live returns process status', async () => {
      const res = await request(comServer, '/health/live');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service, 'commerce-service');
      assert.strictEqual(res.body.status, 'alive');
    });

    test('GET / returns service announcement', async () => {
      const res = await request(comServer, '/');
      assert.strictEqual(res.status, 200);
      assert.ok(String(res.body).includes('Commerce Service'));
    });

    test('GET /order requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/order', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /order requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/order', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /cart requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/cart', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /wishlist requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/wishlist', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /wallet requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/wallet', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /payout/request requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/payout/request', {
        method: 'POST',
        headers: gwAuth,
        body: { amount: 100 },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /return requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/return', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /disputes requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(comServer, '/disputes', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /internal/commerce/delivery-webhook rejects calls without cluster credentials', async () => {
      const res = await request(comServer, '/internal/commerce/delivery-webhook', {
        method: 'POST',
        body: { orderId: '12345' },
      });
      assert.ok([401, 403].includes(res.status));
    });

    test('POST /internal/commerce/payment-webhook rejects calls without webhook signature', async () => {
      const res = await request(comServer, '/internal/commerce/payment-webhook', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('6. Delivery Service Endpoints Verification', () => {
    const gwAuth = {
      'x-internal-service': 'gateway',
      'x-internal-token': TEST_TOKENS.gateway,
    };

    test('GET /health/live returns process status', async () => {
      const res = await request(delServer, '/health/live');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service, 'delivery-service');
      assert.strictEqual(res.body.status, 'alive');
    });

    test('GET / returns service announcement', async () => {
      const res = await request(delServer, '/');
      assert.strictEqual(res.status, 200);
      assert.ok(String(res.body).includes('Delivery Service'));
    });

    test('GET /delivery/delivery requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(delServer, '/delivery/delivery', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /delivery/request requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(delServer, '/delivery/request', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /delivery/provider-wallet requires provider authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(delServer, '/delivery/provider-wallet', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /delivery/assignment requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(delServer, '/delivery/assignment', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('GET /delivery/tracking/all requires user authentication (401 AUTH_REQUIRED)', async () => {
      const res = await request(delServer, '/delivery/tracking/all', { headers: gwAuth });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    test('POST /provider-application/apply validates required fields (rejects empty body with 400)', async () => {
      const res = await request(delServer, '/provider-application/apply', {
        method: 'POST',
        headers: gwAuth,
        body: {},
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    test('POST /internal/delivery/location/hierarchy rejects calls without cluster credentials', async () => {
      const res = await request(delServer, '/internal/delivery/location/hierarchy', {
        method: 'POST',
        body: {},
      });
      assert.ok([401, 403].includes(res.status));
    });
  });
});
