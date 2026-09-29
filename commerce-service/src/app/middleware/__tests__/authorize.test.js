// Canonical authorize() — the gateway-free role gate shared (byte-identically)
// by identity, commerce and delivery. These cases pin the vocabulary the whole
// platform answers with, because a drift here is invisible to every other suite.
const test = require('node:test');
const assert = require('node:assert');
const authorize = require('../authorize');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function run(middleware, user) {
  const req = user === undefined ? {} : { user };
  const res = mockRes();
  let nexted = false;
  middleware(req, res, () => { nexted = true; });
  return { nexted, res, req };
}

test('a buyer passes a BUYER gate', () => {
  const out = run(authorize('BUYER'), { role: 'BUYER', capabilities: ['BUYER'] });
  assert.strictEqual(out.nexted, true);
});

test('a missing principal is AUTH_REQUIRED (401), not a generic 403', () => {
  const out = run(authorize('BUYER'), undefined);
  assert.strictEqual(out.nexted, false);
  assert.strictEqual(out.res.statusCode, 401);
  assert.strictEqual(out.res.body.code, 'AUTH_REQUIRED');
});

test('a role that is not listed is ROLE_REQUIRED', () => {
  const out = run(authorize('SELLER'), { role: 'BUYER', capabilities: ['BUYER'] });
  assert.strictEqual(out.res.statusCode, 403);
  assert.strictEqual(out.res.body.code, 'ROLE_REQUIRED');
});

test('capabilities satisfy a gate exactly like the primary role', () => {
  const out = run(authorize('PROVIDER'), {
    role: 'SELLER',
    capabilities: ['BUYER', 'SELLER', 'PROVIDER'],
  });
  assert.strictEqual(out.nexted, true);
});

test('SELLER inherits BUYER unless the gate asks for the exact role', () => {
  const seller = { role: 'SELLER', capabilities: ['BUYER', 'SELLER'] };
  assert.strictEqual(run(authorize(['BUYER']), seller).nexted, true);
  const exact = run(authorize('BUYER', { exact: true }), {
    role: 'SELLER',
    capabilities: ['BUYER', 'SELLER'],
  });
  // The capability list still counts — `exact` only removes the implicit
  // inheritance, so this asserts the documented (not idealised) behaviour.
  assert.strictEqual(exact.nexted, true);
});

test('ADMIN has no implicit bypass', () => {
  const out = run(authorize('SELLER'), { role: 'ADMIN', capabilities: ['ADMIN'] });
  assert.strictEqual(out.res.body.code, 'ROLE_REQUIRED');
});

test('legacy CUSTOMER spelling is normalized on both sides', () => {
  assert.strictEqual(run(authorize('CUSTOMER'), { role: 'CUSTOMER', capabilities: ['CUSTOMER'] }).nexted, true);
  assert.strictEqual(run(authorize('BUYER'), { role: 'CUSTOMER', capabilities: ['CUSTOMER'] }).nexted, true);
  assert.strictEqual(run(authorize('SELLER'), { role: 'CUSTOMER', capabilities: ['CUSTOMER'] }).res.body.code, 'ROLE_REQUIRED');
});

test('a PENDING membership answers ROLE_NOT_APPROVED, not ROLE_REQUIRED', () => {
  const out = run(authorize('SELLER'), {
    role: 'BUYER',
    capabilities: ['BUYER'],
    roleStatuses: { SELLER: 'PENDING' },
  });
  assert.strictEqual(out.res.statusCode, 403);
  assert.strictEqual(out.res.body.code, 'ROLE_NOT_APPROVED');
  assert.match(out.res.body.message, /pending approval/);
});

test('REJECTED and SUSPENDED memberships answer with their own code', () => {
  const rejected = run(authorize('SELLER'), {
    role: 'BUYER',
    capabilities: ['BUYER'],
    roleStatuses: { SELLER: 'REJECTED' },
  });
  assert.strictEqual(rejected.res.body.code, 'ROLE_REJECTED');

  const suspended = run(authorize('PROVIDER'), {
    role: 'BUYER',
    capabilities: ['BUYER'],
    roleStatuses: { PROVIDER: 'SUSPENDED' },
  });
  assert.strictEqual(suspended.res.body.code, 'ROLE_SUSPENDED');
});

test('an ACTIVE membership passes the status gate', () => {
  const out = run(authorize('SELLER'), {
    role: 'SELLER',
    capabilities: ['BUYER', 'SELLER'],
    roleStatuses: { SELLER: 'ACTIVE' },
  });
  assert.strictEqual(out.nexted, true);
});

test('a token without the role_statuses claim keeps the old behaviour', () => {
  const out = run(authorize('SELLER'), {
    role: 'SELLER',
    capabilities: ['BUYER', 'SELLER'],
    roleStatuses: null,
  });
  assert.strictEqual(out.nexted, true);
});

test('one role of several may be blocked while another still passes', () => {
  // SELLER is suspended but the gate also accepts BUYER, which is fine.
  const out = run(authorize(['SELLER', 'BUYER']), {
    role: 'BUYER',
    capabilities: ['BUYER'],
    roleStatuses: { SELLER: 'SUSPENDED' },
  });
  assert.strictEqual(out.nexted, true);
});
