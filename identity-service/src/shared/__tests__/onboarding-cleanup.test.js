'use strict';
// Abandoned-onboarding sweep (services/onboarding.service.js).
//
// A scripted in-memory "database" stands in for PostgreSQL so the whole pass —
// select candidates, delete memberships, optionally archive accounts — can be
// exercised deterministically, including that it is wrapped in a transaction.
const { test } = require('node:test');
const assert = require('node:assert');

const { runAbandonedCleanup } = require('../../services/onboarding.service');

// A row as the repository's listAbandonedPending would return it.
function abandonedRow(userId, role) {
  const past = new Date('2000-01-01T00:00:00Z');
  return {
    user_id: userId,
    role,
    status: 'PENDING',
    source: 'SELLER_APPLICATION',
    granted_at: past,
    updated_at: past,
    onboarding_completed: false,
    onboarding_started_at: past,
    onboarding_completed_at: null,
  };
}

// Build a fake pool whose client answers each SQL shape from `handlers` and
// records every statement it saw.
function scriptedPool({ abandoned = [], archivable = [], deletedRowCount = null } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/DELETE FROM user_roles/i.test(text)) {
        return { rows: [], rowCount: deletedRowCount === null ? (params[0] || []).length : deletedRowCount };
      }
      if (/FROM user_roles[\s\S]*onboarding_completed = false/i.test(text)) {
        return { rows: abandoned, rowCount: abandoned.length };
      }
      if (/FROM users u/i.test(text)) {
        return { rows: archivable.map((id) => ({ id })), rowCount: archivable.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, client, calls };
}

test('reclaims abandoned memberships inside one transaction', async () => {
  const { pool, client } = scriptedPool({ abandoned: [abandonedRow('u1', 'SELLER'), abandonedRow('u2', 'PROVIDER')] });

  const summary = await runAbandonedCleanup({ olderThanDays: 30, pool });

  assert.equal(summary.scanned, 2);
  assert.equal(summary.removed, 2);
  assert.equal(summary.archived, 0);
  assert.equal(summary.olderThanDays, 30);

  const heads = client.calls.map((c) => c.sql.trim().split(/\s+/)[0].toUpperCase());
  assert.equal(heads[0], 'BEGIN', 'the pass opens a transaction');
  assert.ok(heads.includes('DELETE'), 'abandoned memberships are deleted');
  assert.equal(heads[heads.length - 1], 'COMMIT', 'and commits');

  const del = client.calls.find((c) => /DELETE FROM user_roles/i.test(c.sql));
  assert.deepEqual(del.params[0], ['u1', 'u2']);
  assert.deepEqual(del.params[1], ['SELLER', 'PROVIDER']);
});

test('does nothing (and never deletes) when there is nothing abandoned', async () => {
  const { pool, client } = scriptedPool({ abandoned: [] });

  const summary = await runAbandonedCleanup({ olderThanDays: 30, pool });

  assert.equal(summary.scanned, 0);
  assert.equal(summary.removed, 0);
  assert.equal(summary.archived, 0);
  assert.equal(client.calls.some((c) => /DELETE FROM user_roles/i.test(c.sql)), false);
  const heads = client.calls.map((c) => c.sql.trim().split(/\s+/)[0].toUpperCase());
  assert.equal(heads[0], 'BEGIN');
  assert.equal(heads[heads.length - 1], 'COMMIT');
});

test('archives the now-empty accounts only when asked to', async () => {
  const { pool, client } = scriptedPool({
    abandoned: [abandonedRow('u1', 'SELLER')],
    archivable: ['u1'],
  });

  const summary = await runAbandonedCleanup({ olderThanDays: 30, archiveAccounts: true, pool });

  assert.equal(summary.removed, 1);
  assert.equal(summary.archived, 1);
  const archived = client.calls.find((c) => /UPDATE users SET status/i.test(c.sql));
  assert.ok(archived, 'the empty account is marked inactive');
  assert.deepEqual(archived.params, ['inactive', 'u1']);
});

test('leaves accounts untouched when archiving is not requested', async () => {
  const { pool, client } = scriptedPool({ abandoned: [abandonedRow('u1', 'SELLER')], archivable: ['u1'] });

  const summary = await runAbandonedCleanup({ olderThanDays: 30, archiveAccounts: false, pool });

  assert.equal(summary.archived, 0);
  assert.equal(client.calls.some((c) => /UPDATE users SET status/i.test(c.sql)), false);
});
