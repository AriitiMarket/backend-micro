const http = require('http');
const env = require('./config/env');

// Retries are unbounded (the process must survive a cold boot); these knobs only
// shape the delay between attempts and how often the failure banner is printed.
const NOTICE_ATTEMPTS = env.dbConnectNoticeAttempts;
const RETRY_DELAY_MS = env.dbConnectRetryDelayMs;
const RETRY_MAX_DELAY_MS = env.dbConnectRetryMaxDelayMs;

let dbReady = false;
let app = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load the Express app lazily and tolerantly: a transient module/require error
// must not take the process down before the database is reachable.
function loadApp() {
  if (app) return true;
  try {
    app = require('./app');
    return true;
  } catch (err) {
    console.error('[identity] failed to load express app (will retry):', err.message);
    return false;
  }
}

// Keep retrying until the database answers. Never throws, never exits: a slow or
// unreachable database must not turn into a container crash loop, so the retry
// loop is allowed to run for as long as a cold boot needs.
async function connectWithRetry() {
  const { getPool } = require('./config/database');
  let attempts = 0;
  let sinceNotice = 0;
  for (;;) {
    attempts += 1;
    try {
      await getPool();
      dbReady = true;
      loadApp();
      console.log('[identity] database connected after ' + attempts + ' attempt(s)');
      // Start the abandoned-onboarding sweep only once the schema is known to be
      // up. Loaded lazily so a transient require error can never abort startup —
      // the job is an optimization, not something the API depends on.
      try {
        const { startOnboardingCleanup } = require('./jobs/onboardingCleanup');
        startOnboardingCleanup();
      } catch (err) {
        console.error('[identity] failed to start onboarding cleanup job:', err.message);
      }
      return;
    } catch (err) {
      sinceNotice += 1;
      console.error(`[identity] database connection attempt ${sinceNotice}/${NOTICE_ATTEMPTS} failed: ${err.message}`);
      if (sinceNotice >= NOTICE_ATTEMPTS) {
        console.error(
          `[identity] database still unavailable after ${attempts} attempts; retrying every ${RETRY_DELAY_MS}-${RETRY_MAX_DELAY_MS}ms (process stays alive)`
        );
        sinceNotice = 0;
      }
      // Capped exponential backoff + jitter: reacts quickly right after boot but
      // stops hammering a database that is still initialising.
      const backoff = Math.min(RETRY_MAX_DELAY_MS, Math.round(RETRY_DELAY_MS * Math.pow(1.5, attempts - 1)));
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
}

const server = http.createServer(function (req, res) {
  const path = req.url.split('?')[0];

  // Liveness: is the process up? Never touches PostgreSQL, so an orchestrator
  // restarting on this signal can only ever be reacting to a broken process.
  if (path === '/health/live' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive' }));
    return;
  }

  // Readiness: ready only when both PostgreSQL and the Express app are up, so
  // Compose / the gateway can never route to an instance that could only answer
  // 503. Handled here (above the Express app) because the answer must be correct
  // even while the app is still being loaded.
  if ((path === '/health' || path === '/health/ready') && req.method === 'GET') {
    if (dbReady && app) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: dbReady ? 'app_loading' : 'db_unavailable' }));
    }
    return;
  }
  if (app) {
    app(req, res);
  } else {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Service starting');
  }
});

server.listen(env.port, function () {
  console.log('Identity Service listening on port ' + env.port);

  loadApp();

  connectWithRetry().catch(function (err) {
    // Unreachable in practice — connectWithRetry only returns once connected —
    // but the listener must never be torn down by an unexpected error.
    console.error('[identity] database retry loop stopped:', err.message);
  });
});
