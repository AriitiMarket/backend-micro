/**
 * Response envelope tests — `ok` / `created` / `toEnvelope`.
 *
 * Guards two real defects:
 *   - spreading a Mongoose document leaked its internal cache (`$__`,
 *     `activePaths`, …) into the JSON body;
 *   - spreading an array produced `{ 0: …, 1: … }` instead of a keyed list.
 *
 * Uses Node's built-in test runner; no database access is required.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it } = require('node:test');
const { ok, created, toEnvelope } = require('../utils/response');

const TestDoc = mongoose.model('ResponseEnvelopeTestDoc', new mongoose.Schema({
  name: { type: String },
  amount: { type: Number },
}));

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('response envelope', () => {
  it('ok() responds 200 with success and message', () => {
    const res = fakeRes();
    ok(res, { total: 3 }, 'fine');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, message: 'fine', total: 3 });
  });

  it('created() responds 201', () => {
    const res = fakeRes();
    created(res, { id: 'x' });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.id, 'x');
  });

  it('keeps plain objects at the top level (admin settings contract)', () => {
    const res = fakeRes();
    ok(res, { theme: 'dark', features: { beta: true } });
    assert.strictEqual(res.body.theme, 'dark');
    assert.deepStrictEqual(res.body.features, { beta: true });
  });

  it('does not leak Mongoose internals when a document is spread', () => {
    const res = fakeRes();
    ok(res, new TestDoc({ name: 'sector-a', amount: 12 }));

    const json = JSON.stringify(res.body);
    assert.ok(!json.includes('$__'), 'leaked $__ internal cache');
    assert.ok(!json.includes('activePaths'), 'leaked activePaths');
    assert.ok(!json.includes('scope'), 'leaked scope');

    assert.strictEqual(res.body.name, 'sector-a');
    assert.strictEqual(res.body.amount, 12);
    assert.ok(res.body._id, 'public _id is preserved');
  });

  it('leaves a lean/plain document alone', () => {
    const doc = { _id: 'abc', name: 'plain' };
    assert.strictEqual(toEnvelope(doc), doc);
  });

  it('wraps arrays under data instead of spreading numeric keys', () => {
    const res = fakeRes();
    ok(res, [{ name: 'a' }, { name: 'b' }]);
    assert.strictEqual(res.body['0'], undefined, 'array must not spread into numeric keys');
    assert.strictEqual(res.body.data.length, 2);
    assert.strictEqual(res.body.data[0].name, 'a');
  });

  it('converts arrays of documents to plain JSON', () => {
    const res = fakeRes();
    ok(res, [new TestDoc({ name: 'one' })]);
    const json = JSON.stringify(res.body);
    assert.ok(!json.includes('$__'));
    assert.strictEqual(res.body.data[0].name, 'one');
  });

  it('tolerates null/undefined data', () => {
    const res = fakeRes();
    ok(res, null);
    assert.deepStrictEqual(res.body, { success: true, message: '' });
    const res2 = fakeRes();
    created(res2, undefined);
    assert.strictEqual(res2.statusCode, 201);
  });
});
