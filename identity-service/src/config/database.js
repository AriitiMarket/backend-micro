// PostgreSQL connection pool and schema bootstrap for Identity Service.
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
    // Abort a *single* connection attempt after this long (default 30s). The old
    // hard-coded 5s was shorter than a cold-boot DNS/TCP handshake, which is what
    // produced "Connection terminated due to connection timeout" during startup.
    connectionTimeoutMillis: env.dbConnectTimeoutMs,
    // Client-side guard so a wedged socket cannot hang a request forever.
    query_timeout: env.dbQueryTimeoutMs,
    // Server-side guard against transactions left idle by a crashed worker.
    idle_in_transaction_session_timeout: env.dbIdleInTransactionTimeoutMs,
    idleTimeoutMillis: env.dbIdleTimeoutMs,
    max: env.dbPoolMax,
    // The HTTP listener owns the event loop; never let an idle pool exit on us.
    allowExitOnIdle: false,
  };

  const ssl = resolveSSL(env.databaseUrl);
  if (ssl !== undefined) {
    poolConfig.ssl = ssl;
  }

  const p = new Pool(poolConfig);

  // CRITICAL: a pg Pool emits 'error' when a client breaks while idle (postgres
  // restart, network partition). With no listener, Node promotes that to an
  // uncaught exception and kills the process — a premature crash that would
  // abort the startup retry loop before it can ever finish.
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

  // Single-flight: the startup probe and concurrent /health calls share one
  // attempt instead of each building (and leaking) their own pool.
  initPromise = (async () => {
    await p.query('SELECT 1');
    await initSchema(p);
    return p;
  })();

  try {
    return await initPromise;
  } catch (err) {
    // Drop the cached attempt so the caller's retry loop can try again on the
    // same, still-usable pool (pg-pool evicts the dead client itself).
    initPromise = null;
    throw err;
  }
}


async function getPool() {
  return initPool();
}

module.exports = { getPool };
