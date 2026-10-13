'use strict';
// config/transaction.js — the all-or-nothing wrapper every multi-write role and
// onboarding change depends on. These tests use a fake pool, so no PostgreSQL is
// required.
const { test } = require('node:test');
const assert = require('node:assert');

const { withTransaction } = require('../../config/transaction');

function fakePool() {
  const calls = [];
  const client = {
    calls,
    released: false,
    async query(sql) {
      calls.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
      return { rows: [], rowCount: 0 };
    },
    release() { this.released = true; },
  };
  return { client, pool: { async connect() { return client; } } };
}

test('commits on success and always releases the connection', async () => {
  const { pool, client } = fakePool();
  const result = await withTransaction(async (c) => {
    assert.equal(c, client, 'the body runs on the acquired client');
    await c.query('INSERT INTO user_roles (user_id) VALUES ($1);');
    return 42;
  }, { pool });

  assert.equal(result, 42);
  assert.deepEqual(client.calls, ['BEGIN', 'INSERT', 'COMMIT']);
  assert.equal(client.released, true);
});

test('rolls back and rethrows when the body fails', async () => {
  const { pool, client } = fakePool();
  await assert.rejects(
    () => withTransaction(async (c) => {
      await c.query('UPDATE users SET role = $1;');
      throw new Error('second write failed');
    }, { pool }),
    /second write failed/
  );

  assert.deepEqual(client.calls, ['BEGIN', 'UPDATE', 'ROLLBACK']);
  assert.equal(client.released, true);
});

test('a failing ROLLBACK still rethrows the original error and releases', async () => {
  const { pool, client } = fakePool();
  client.query = async (sql) => {
    const head = String(sql).trim().split(/\s+/)[0].toUpperCase();
    client.calls.push(head);
    if (head === 'ROLLBACK') throw new Error('connection already gone');
    return { rows: [], rowCount: 0 };
  };

  await assert.rejects(
    () => withTransaction(async () => { throw new Error('original error'); }, { pool }),
    /original error/
  );
  assert.equal(client.calls.includes('ROLLBACK'), true);
  assert.equal(client.released, true);
});

test('a connect failure propagates without leaking a client', async () => {
  const pool = { async connect() { throw new Error('pool exhausted'); } };
  await assert.rejects(() => withTransaction(async () => 1, { pool }), /pool exhausted/);
});
