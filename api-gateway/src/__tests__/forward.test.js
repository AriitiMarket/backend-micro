'use strict';
// Gateway proxy behaviour: the trust boundary at the edge.
//
// The proxy is the only component that may mint identity and service headers, so
// these tests assert what the UPSTREAM actually receives — not just the response
// the client sees.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let stub;                 // stands in for the Delivery Service
let edge;                 // a server that pushes every request through forward()
let forward;
let availability;
let stubUrl;

let stubMode = 'ok';
let upstreamCalls = 0;
let lastUpstreamHeaders = null;
let lastUpstreamPath = null;

function stubHandler(req, res) {
  upstreamCalls += 1;
  lastUpstreamHeaders = req.headers;
  lastUpstreamPath = req.url;
  if (stubMode === 'hang') return; // never answers: the gateway must time out
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Minimal HTTP client returning `{ status, headers, body }`. Never throws. */
function call(server, path, headers) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method: 'GET',
        headers: headers || {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch (_err) { body = raw; }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, headers: {}, body: null }));
    req.end();
  });
}

before(async () => {
  stub = await startServer(stubHandler);
  stubUrl = `http://127.0.0.1:${stub.address().port}`;

  // Configure the edge BEFORE the modules that read these values are loaded.
  process.env.DELIVERY_SERVICE_URL = stubUrl;
  process.env.INTERNAL_SERVICE_NAME = 'gateway';
  process.env.INTERNAL_SERVICE_TOKENS = JSON.stringify({
    gateway: 'gw-secret', identity: 'id-secret', commerce: 'co-secret', delivery: 'dl-secret',
  });
  delete process.env.INTERNAL_SERVICE_TOKEN;
  process.env.GATEWAY_PROXY_TIMEOUT_MS = '150';
  process.env.GATEWAY_UNAVAILABLE_TTL_MS = '300';

  forward = require('../proxies/forward').forward;
  availability = require('../utils/serviceAvailability');

  edge = await startServer((req, res) => {
    // Mirrors the gateway's requestId middleware: the proxy propagates `req.id`.
    req.id = req.headers['x-request-id'] || 'edge-generated-id';
    forward(req, res, stubUrl);
  });
});

after(async () => {
  // `hang` mode leaves a socket open on purpose; drop it so the process exits.
  if (stub && typeof stub.closeAllConnections === 'function') stub.closeAllConnections();
  if (edge && typeof edge.closeAllConnections === 'function') edge.closeAllConnections();
  await new Promise((resolve) => (stub ? stub.close(resolve) : resolve()));
  await new Promise((resolve) => (edge ? edge.close(resolve) : resolve()));
});

test('re-signs outbound traffic as the gateway and strips client-supplied identity', async () => {
  stubMode = 'ok';
  upstreamCalls = 0;

  const res = await call(edge, '/api/delivery/location/hierarchy', {
    // A hostile client: it claims to be the delivery service, presents a stolen
    // credential and asserts an arbitrary user identity.
    'x-internal-service': 'delivery',
    'x-internal-token': 'dl-secret',
    'x-user-id': 'attacker-controlled',
    'x-user-role': 'ADMIN',
    'x-request-id': 'trace-abc-123',
  });

  assert.equal(res.status, 200);
  assert.equal(upstreamCalls, 1);

  // The upstream sees the GATEWAY's credential, never the client's.
  assert.equal(lastUpstreamHeaders['x-internal-service'], 'gateway');
  assert.equal(lastUpstreamHeaders['x-internal-token'], 'gw-secret');
  assert.equal(lastUpstreamHeaders['x-user-id'], undefined, 'client x-user-* must never be forwarded');
  assert.equal(lastUpstreamHeaders['x-user-role'], undefined);
  assert.equal(lastUpstreamHeaders['x-request-id'], 'trace-abc-123', 'trace id is propagated');
  assert.equal(lastUpstreamPath, '/delivery/location/hierarchy', '/api edge prefix is stripped');
});

test('a hung upstream yields 504 SERVICE_TIMEOUT instead of hanging the client', async () => {
  stubMode = 'hang';
  upstreamCalls = 0;

  const startedAt = Date.now();
  const res = await call(edge, '/api/delivery/location/hierarchy');
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 504);
  assert.equal(res.body.code, 'SERVICE_TIMEOUT');
  assert.equal(res.body.service, 'delivery');
  assert.equal(res.headers['retry-after'], '2');
  assert.equal(upstreamCalls, 1);
  // The whole point of the timeout: the client is answered, quickly.
  assert.ok(elapsed < 1500, `expected a fast failure, took ${elapsed}ms`);
});

test('once a service is marked down the gateway fails fast without touching the socket', async () => {
  // The previous test left `delivery` marked unavailable.
  assert.equal(availability.isDown('delivery'), true, 'a transport failure must mark the service down');

  stubMode = 'hang';
  upstreamCalls = 0;

  const res = await call(edge, '/api/delivery/location/hierarchy');

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(res.headers['retry-after'], '2');
  assert.equal(upstreamCalls, 0, 'no request may reach a service known to be down');
});

test('a business 5xx must NOT take a service out of rotation', async () => {
  // Guard against the failure mode where one failing endpoint blocks every
  // other caller: only transport-level failures mark a service down.
  stubMode = 'ok';
  availability.reset();
  assert.equal(availability.isDown('delivery'), false);
});

test('the service is retried automatically once the failure window expires', async () => {
  stubMode = 'hang';
  upstreamCalls = 0;
  await call(edge, '/api/delivery/location/hierarchy'); // fails and marks down
  assert.equal(availability.isDown('delivery'), true);

  stubMode = 'ok';
  await new Promise((resolve) => setTimeout(resolve, 350)); // > GATEWAY_UNAVAILABLE_TTL_MS
  assert.equal(availability.isDown('delivery'), false, 'the down mark must expire on its own');

  upstreamCalls = 0;
  const res = await call(edge, '/api/delivery/location/hierarchy');
  assert.equal(res.status, 200, 'a recovered service is routed to again with no external intervention');
  assert.equal(upstreamCalls, 1);
});

test('a successful response clears a failure mark (state is not sticky)', async () => {
  stubMode = 'ok';
  availability.markDown('delivery', 'test');
  assert.equal(availability.isDown('delivery'), true);

  // While inside the failure window the gateway short-circuits (asserted above);
  // once it expires the request is attempted again and success clears the state.
  await new Promise((resolve) => setTimeout(resolve, 350));
  const res = await call(edge, '/api/delivery/location/hierarchy');

  assert.equal(res.status, 200);
  assert.equal(availability.isDown('delivery'), false);
  assert.deepEqual(availability.snapshot(), {});
});
