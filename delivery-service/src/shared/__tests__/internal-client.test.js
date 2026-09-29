'use strict';
// Service-to-service transport behaviour (shared/internal-client).
//
// These are the guarantees that make a dependency failure diagnosable instead of
// silent: a bounded timeout, trace propagation, a structured result, and safe
// retries only.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createInternalClient, ServiceCallError } = require('../internal-client');
const { loadCredentials } = require('../internal-auth');

const CREDENTIALS = loadCredentials({
  INTERNAL_SERVICE_NAME: 'commerce',
  INTERNAL_SERVICE_TOKENS: JSON.stringify({ commerce: 'co-secret', delivery: 'dl-secret' }),
}, 'commerce');

let stub;
let stubUrl;
let mode = 'ok';
let calls = 0;
let lastRequest = null;

function stubHandler(req, res) {
  calls += 1;
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    lastRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    };
    if (mode === 'hang') return;
    if (mode === 'server-error') { res.writeHead(503); res.end('{}'); return; }
    if (mode === 'client-error') { res.writeHead(400); res.end(JSON.stringify({ message: 'bad input' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: lastRequest.body }));
  });
}

function clientFor(overrides) {
  return createInternalClient(Object.assign({
    name: 'commerce',
    baseUrl: stubUrl,
    credentials: CREDENTIALS,
    timeoutMs: 200,
    maxRetries: 0,
  }, overrides));
}

before(async () => {
  stub = http.createServer(stubHandler);
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${stub.address().port}`;
});

after(async () => {
  if (typeof stub.closeAllConnections === 'function') stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
});

test('presents the caller\'s own identity, credential and the trace id', async () => {
  mode = 'ok';
  calls = 0;
  const client = clientFor();

  const res = await client.request('GET', '/internal/delivery/locations/counts', {
    requestId: 'trace-42',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(lastRequest.headers['x-internal-service'], 'commerce');
  assert.equal(lastRequest.headers['x-internal-token'], 'co-secret');
  assert.equal(lastRequest.headers['x-request-id'], 'trace-42');
  assert.equal(res.requestId, 'trace-42');
  assert.equal(res.attempts, 1);
  assert.equal(typeof res.durationMs, 'number');
});

test('serialises a JSON body and query parameters, dropping empty values', async () => {
  mode = 'ok';
  const client = clientFor();

  await client.request('GET', '/internal/delivery/deliveries', {
    query: { status: 'failed', limit: 10, skip: undefined, empty: '' },
  });
  assert.equal(lastRequest.url, '/internal/delivery/deliveries?status=failed&limit=10');

  await client.post('/internal/delivery/deliveries/by-orders', { orderIds: ['a'] });
  assert.equal(lastRequest.method, 'POST');
  assert.deepEqual(lastRequest.body, { orderIds: ['a'] });
  assert.equal(lastRequest.headers['content-type'], 'application/json');
});

test('a 4xx is reported, not thrown — callers still read `.status`', async () => {
  mode = 'client-error';
  const client = clientFor();

  const res = await client.request('GET', '/internal/identity/users/1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.code, 'BAD_REQUEST');

  // Legacy parity: the old clients resolved `{ status, body }` for 4xx too.
  const viaThrow = await client.requestOrThrow('GET', '/internal/identity/users/1');
  assert.equal(viaThrow.status, 400);
});

test('a transport failure becomes status 0 / SERVICE_UNAVAILABLE, and throws in the strict API', async () => {
  // Reserve a port, then close it so nothing is listening.
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((resolve) => dead.close(resolve));

  const client = clientFor({ baseUrl: deadUrl });

  const res = await client.request('POST', '/internal/delivery/request', { orderId: 'o1' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.equal(res.code, 'SERVICE_UNAVAILABLE');

  await assert.rejects(
    () => client.requestOrThrow('POST', '/internal/delivery/request', { orderId: 'o1' }),
    (err) => err instanceof ServiceCallError && err.status === 0
  );
});

test('every call is bounded by a timeout', async () => {
  mode = 'hang';
  const client = clientFor({ timeoutMs: 150 });

  const startedAt = Date.now();
  const res = await client.request('GET', '/internal/delivery/deliveries');
  const elapsed = Date.now() - startedAt;

  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.equal(res.code, 'SERVICE_TIMEOUT');
  assert.ok(elapsed < 1500, `expected a bounded failure, took ${elapsed}ms`);
});

test('an idempotent request is retried, a POST is not', async () => {
  mode = 'server-error';
  calls = 0;
  const client = clientFor({ maxRetries: 2 });

  const get = await client.request('GET', '/internal/delivery/deliveries');
  assert.equal(get.attempts, 3, 'GET is retried up to the budget');
  assert.equal(calls, 3);
  assert.equal(get.code, 'SERVICE_ERROR');

  calls = 0;
  const post = await client.request('POST', '/internal/delivery/request', { orderId: 'o1' });
  assert.equal(post.attempts, 1, 'a POST must never be retried implicitly');
  assert.equal(calls, 1);
});

test('a caller may declare a POST idempotent to opt into retries', async () => {
  mode = 'server-error';
  calls = 0;
  const client = clientFor({ maxRetries: 1 });

  const post = await client.post('/internal/delivery/request', { orderId: 'o1' }, { idempotent: true });
  assert.equal(post.attempts, 2);
  assert.equal(calls, 2);
});

test('without a cluster credential nothing is sent at all (fail closed)', async () => {
  mode = 'ok';
  calls = 0;
  // A per-service map that does not contain this caller, and no shared fallback.
  const client = createInternalClient({
    name: 'billing',
    baseUrl: stubUrl,
    credentials: loadCredentials({ INTERNAL_SERVICE_TOKENS: '{"gateway":"gw"}' }, 'billing'),
  });

  const res = await client.request('GET', '/internal/delivery/deliveries');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_SERVICE_CREDENTIAL');
  assert.equal(res.status, 0);
  assert.equal(calls, 0, 'no anonymous internal request may ever leave the process');
});

test('an invalid base URL is reported instead of crashing the caller', async () => {
  const client = createInternalClient({ name: 'commerce', baseUrl: 'not-a-url', credentials: CREDENTIALS });
  const res = await client.request('GET', '/internal/delivery/deliveries');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_SERVICE_URL');
});
