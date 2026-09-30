'use strict';
/**
 * Integration-test harness.
 *
 * Boots the REAL Delivery Service express app against a real MongoDB and drives
 * it over HTTP with the exact headers the API Gateway injects, so routing,
 * authentication, authorization, validation, the state machine and the database
 * are all exercised together — nothing is stubbed.
 *
 * The database name is derived from the test file, so the suites can run in
 * parallel without sharing state. When MongoDB is not reachable the callers skip
 * (with an explicit reason) instead of reporting a false failure.
 */
const http = require('node:http');

const MONGO_BASE = process.env.ARITII_TEST_MONGO || 'mongodb://127.0.0.1:27017';

// The cluster credentials the service validates inbound requests against. Set
// BEFORE the app (and its `gatewayOnly` middleware) is required: the credential
// map is read once, at module load.
const INTERNAL_TOKENS = {
  gateway: 'integration-test-gateway-token',
  identity: 'integration-test-identity-token',
  commerce: 'integration-test-commerce-token',
  delivery: 'integration-test-delivery-token',
};
const INTERNAL_TOKEN = INTERNAL_TOKENS.gateway;
process.env.INTERNAL_SERVICE_NAME = process.env.INTERNAL_SERVICE_NAME || 'delivery';
process.env.INTERNAL_SERVICE_TOKENS = JSON.stringify(INTERNAL_TOKENS);
process.env.INTERNAL_SERVICE_TOKEN = '';

// Audit and identity provisioning are fire-and-forget outbound calls. In a
// bare-metal test run neither service is reachable, and the default 5s timeout
// would add 5 seconds PER audited action (the suites started taking minutes).
// A 1ms budget fails instantly and is exactly what these calls are designed to
// tolerate.
process.env.AUDIT_CALL_TIMEOUT_MS = process.env.AUDIT_CALL_TIMEOUT_MS || '1';
process.env.IDENTITY_CALL_TIMEOUT_MS = process.env.IDENTITY_CALL_TIMEOUT_MS || '1';

function createHarness(suffix) {
  process.env.MONGODB_URI = `${MONGO_BASE}/aritii_delivery_int_${suffix}`;

  const mongoose = require('mongoose');
  const app = require('../../src/app/routes/app');

  let server = null;
  let baseUrl = null;
  let connected = false;

  async function connect() {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 });
      connected = true;
      return true;
    } catch (_err) {
      connected = false;
      return false;
    }
  }

  async function dropDatabase() {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  }

  async function start() {
    if (!(await connect())) return false;
    await dropDatabase();
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return true;
  }

  async function stop() {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close(false);
    }
    await mongoose.disconnect().catch(() => null);
  }

  /**
   * One HTTP call. `as` selects the authenticated actor whose identity headers
   * the gateway would inject; `internal` selects the peer credential the call
   * presents; `unsigned` sends no cluster credential at all.
   */
  async function request(path, { method = 'GET', body, as, internal, unsigned, headers = {} } = {}) {
    const finalHeaders = {};
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
    if (unsigned) {
      // no credential headers: a direct caller pretending to be the edge
    } else if (internal) {
      finalHeaders['x-internal-service'] = internal;
      finalHeaders['x-internal-token'] = INTERNAL_TOKENS[internal] || `unknown-caller-${internal}`;
    } else if (as === undefined) {
      // Anonymous from the public edge: the gateway signs the request but adds
      // no user identity.
      finalHeaders['x-internal-service'] = 'gateway';
      finalHeaders['x-internal-token'] = INTERNAL_TOKEN;
    } else {
      finalHeaders['x-internal-service'] = 'gateway';
      finalHeaders['x-internal-token'] = INTERNAL_TOKEN;
      finalHeaders['x-user-id'] = String(as.id);
      finalHeaders['x-user-role'] = as.role;
      if (as.capabilities) finalHeaders['x-user-capabilities'] = as.capabilities.join(',');
      if (as.roleStatuses) finalHeaders['x-user-role-statuses'] = JSON.stringify(as.roleStatuses);
    }
    // Explicit headers are applied last so a test can deliberately override a
    // credential (forged token scenarios).
    Object.assign(finalHeaders, headers);
    const res = await fetch(baseUrl + path, {
      method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const models = {
    Provider: require('../../src/modules/providers/models/Provider'),
    Delivery: require('../../src/modules/delivery-fulfillment/models/Delivery'),
    DeliveryRequest: require('../../src/modules/delivery-fulfillment/models/DeliveryRequest'),
    DeliveryOutboxEvent: require('../../src/modules/delivery-fulfillment/models/DeliveryOutboxEvent'),
    Assignment: require('../../src/modules/operations/models/Assignment'),
    AssignmentBatch: require('../../src/modules/operations/models/AssignmentBatch'),
    TrackingEvent: require('../../src/modules/tracking/models/TrackingEvent'),
    Location: require('../../src/modules/locations-expansion/models/Location'),
    Zone: require('../../src/modules/locations-expansion/models/Zone'),
    Hub: require('../../src/modules/operations/models/Hub'),
    DeliveryRoute: require('../../src/modules/locations-expansion/models/DeliveryRoute'),
    DeliveryService: require('../../src/modules/locations-expansion/models/DeliveryService'),
  };

  const actors = {
    admin: { id: 'user-admin-1', role: 'ADMIN', capabilities: ['ADMIN'], name: 'Admin' },
    buyer: { id: 'user-buyer-1', role: 'BUYER', name: 'Buyer One' },
    otherBuyer: { id: 'user-buyer-2', role: 'BUYER', name: 'Buyer Two' },
    seller: { id: 'user-seller-1', role: 'SELLER', name: 'Seller One' },
    otherSeller: { id: 'user-seller-2', role: 'SELLER', name: 'Seller Two' },
    provider: { id: 'user-provider-1', role: 'PROVIDER', name: 'Provider One' },
    otherProvider: { id: 'user-provider-2', role: 'PROVIDER', name: 'Provider Two' },
    providerNoProfile: { id: 'user-provider-3', role: 'PROVIDER', name: 'No Profile' },
  };

  return {
    app, mongoose, models, actors, request, start, stop, dropDatabase, dropDatabaseSafe: dropDatabase,
    isConnected: () => connected,
    baseUrl: () => baseUrl,
    INTERNAL_TOKEN,
  };
}

module.exports = { createHarness, MONGO_BASE, INTERNAL_TOKEN };
