// PostgreSQL connection pool and schema bootstrap for Identity Service.
'use strict';

const { Pool } = require('pg');
const env = require('./env');
const { initSchema } = require('./schema');

let pool = null;
let initPromise = null;

function resolveSSL(databaseUrl) {
  if (process.env.DATABASE_SSL === 'false' || process.env.PGSSLMODE === 'disable') return false;
  if (process.env.DATABASE_SSL === 'true' || process.env.PGSSLMODE === 'require') {
    return { rejectUnauthorized: false };
  }
  if (!databaseUrl) return undefined;
  try {
    const parsed = new URL(databaseUrl);
    const sslmode = parsed.searchParams.get('sslmode');
    if (sslmode === 'require' || sslmode === 'verify-full' || sslmode === 'verify-ca') {
      return { rejectUnauthorized: false };
    }
    if (sslmode === 'disable') return false;
    if (parsed.hostname && (parsed.hostname.endsWith('.neon.tech') || parsed.hostname.includes('render.com'))) {
      return { rejectUnauthorized: false };
    }
  } catch (_e) {}
  return undefined;
}

function createPool() {
  const poolConfig = {
    connectionString: env.databaseUrl,
    connectionTimeoutMillis: env.dbConnectTimeoutMs,
    query_timeout: env.dbQueryTimeoutMs,
    idle_in_transaction_session_timeout: env.dbIdleInTransactionTimeoutMs,
    idleTimeoutMillis: env.dbIdleTimeoutMs,
    max: env.dbPoolMax,
    allowExitOnIdle: false,
  };

  const ssl = resolveSSL(env.databaseUrl);
  if (ssl !== undefined) {
    poolConfig.ssl = ssl;
  }

  const p = new Pool(poolConfig);

  p.on('error', (err) => {
    console.error('[identity] unexpected PostgreSQL pool error:', err.message);
  });

  return p;
}

function getPoolInstance() {
  if (!pool) pool = createPool();
  return pool;
}

async function initPool() {
  if (initPromise) return initPromise;
  const p = getPoolInstance();

  initPromise = (async () => {
    await p.query('SELECT 1');
    await initSchema(p);
    return p;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

async function getPool() {
  return initPool();
}

function setPool(customPool) {
  pool = customPool;
  initPromise = customPool ? Promise.resolve(customPool) : null;
}

async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}

async function getClient() {
  const p = await getPool();
  return p.connect();
}

/**
 * Run `fn` inside a database transaction, committing on success and
 * rolling back on any error. Supports client-passed and nested transactions.
 */
async function withTransaction(fn, options = {}) {
  // If an active client is passed directly as options, reuse it (nested transaction)
  if (options && typeof options.query === 'function' && typeof options.release === 'function') {
    return fn(options);
  }
  if (options && options.client && typeof options.client.query === 'function') {
    return fn(options.client);
  }

  const p = (options && options.pool) || (await getPool());
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // Original error takes precedence.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  setPool,
  query,
  getClient,
  withTransaction,
};
