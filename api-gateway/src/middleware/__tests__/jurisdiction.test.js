'use strict';
// Gateway jurisdiction enforcement tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const { checkJurisdiction, jurisdictionOf } = require('../jurisdiction');

function fakeReq(token, url) {
  return { token, url };
}

// ── jurisdictionOf ──
test('jurisdictionOf returns null when no admin_scope', () => {
  assert.equal(jurisdictionOf({}), null);
  assert.equal(jurisdictionOf(null), null);
  assert.equal(jurisdictionOf({ admin_scope: undefined }), null);
});

test('jurisdictionOf returns null when all scopes are wildcard', () => {
  assert.equal(jurisdictionOf({ admin_scope: { locations: ['*'], businesses: ['*'], shops: ['*'] } }), null);
});

test('jurisdictionOf extracts location ids from scope', () => {
  const result = jurisdictionOf({ admin_scope: { locations: ['loc-1', 'loc-2'] } });
  assert.deepEqual(result, { locations: ['loc-1', 'loc-2'], businesses: [], shops: [] });
});

test('jurisdictionOf returns empty when any scope has wildcard', () => {
  // A wildcard means "unrestricted", so jurisdictionOf returns null (no enforcement)
  assert.equal(jurisdictionOf({ admin_scope: { locations: ['loc-1', '*'] } }), null);
  assert.equal(jurisdictionOf({ admin_scope: { businesses: ['biz-1', '*'] } }), null);
  assert.equal(jurisdictionOf({ admin_scope: { shops: ['shop-1', '*'] } }), null);
});

test('jurisdictionOf extracts business ids from scope', () => {
  const result = jurisdictionOf({ admin_scope: { businesses: ['biz-1'] } });
  assert.deepEqual(result.businesses, ['biz-1']);
});

test('jurisdictionOf extracts shop ids from scope', () => {
  const result = jurisdictionOf({ admin_scope: { shops: ['shop-1'] } });
  assert.deepEqual(result.shops, ['shop-1']);
});

// ── checkJurisdiction ──
test('checkJurisdiction allows request with no jurisdiction', () => {
  const req = fakeReq(null, '/api/delivery/location/hierarchy?regionId=loc-1');
  const result = checkJurisdiction(req);
  assert.equal(result.ok, true);
});

test('checkJurisdiction allows request within jurisdiction', () => {
  const req = fakeReq(
    { admin_scope: { locations: ['loc-1'] } },
    '/api/delivery/location/hierarchy?regionId=loc-1'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, true);
});

test('checkJurisdiction rejects location outside jurisdiction', () => {
  const req = fakeReq(
    { admin_scope: { locations: ['loc-1'] } },
    '/api/delivery/location/hierarchy?regionId=loc-99'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, false);
  assert.equal(result.param, 'regionId');
  assert.equal(result.value, 'loc-99');
});

test('checkJurisdiction rejects business outside jurisdiction', () => {
  const req = fakeReq(
    { admin_scope: { businesses: ['biz-1'] } },
    '/api/admin/shops?businessId=biz-99'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, false);
  assert.equal(result.param, 'businessId');
  assert.equal(result.value, 'biz-99');
});

test('checkJurisdiction rejects shop outside jurisdiction', () => {
  const req = fakeReq(
    { admin_scope: { shops: ['shop-1'] } },
    '/api/admin/shops?shopId=shop-99'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, false);
  assert.equal(result.param, 'shopId');
  assert.equal(result.value, 'shop-99');
});

test('checkJurisdiction pins unscoped single-location jurisdiction', () => {
  const req = fakeReq(
    { admin_scope: { locations: ['loc-1'] } },
    '/api/admin/shops'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, true);
  assert.equal(result.injectedUrl, '/api/admin/shops?locationId=loc-1');
});

test('checkJurisdiction does not pin when a scope param is already present', () => {
  const req = fakeReq(
    { admin_scope: { locations: ['loc-1'] } },
    '/api/admin/shops?regionId=loc-1'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, true);
  assert.equal(result.injectedUrl, undefined);
});

test('checkJurisdiction allows wildcard jurisdiction (bootstrap admin)', () => {
  const req = fakeReq(
    { admin_scope: { locations: ['*'], businesses: ['*'], shops: ['*'] } },
    '/api/admin/shops?shopId=any-shop'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, true);
});

test('checkJurisdiction ignores params not in jurisdiction', () => {
  const req = fakeReq(
    { admin_scope: { locations: ['loc-1'] } },
    '/api/admin/shops?someOtherParam=value'
  );
  const result = checkJurisdiction(req);
  assert.equal(result.ok, true);
  // Original params preserved, locationId pinned
  assert.equal(result.injectedUrl, '/api/admin/shops?someOtherParam=value&locationId=loc-1');
});
