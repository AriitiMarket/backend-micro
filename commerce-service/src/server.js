// Commerce Service entrypoint.
//
// Connects to MongoDB before listening, with an unbounded retry + delay so a
// slow or briefly-unavailable database does not turn into a crash loop.
const app = require('./app/app');
const env = require('./app/config/env');
const { connectDatabase } = require('./app/config/database');
const { describeServices } = require('./app/config/services');
const { loadCredentials, describeCredentials } = require('./shared/internal-auth');

const MAX_ATTEMPTS = parseInt(process.env.DB_CONNECT_MAX_ATTEMPTS || '10', 10);
const RETRY_DELAY_MS = parseInt(process.env.DB_CONNECT_RETRY_DELAY_MS || '3000', 10);

// Never throws: keeps waiting and retrying until the database answers.
async function connectWithRetry() {
  let attempts = 0;
  let sinceNotice = 0;
  for (;;) {
    attempts += 1;
    try {
      await connectDatabase();
      console.log('[commerce] database connected after ' + attempts + ' attempt(s)');
      return;
    } catch (err) {
      sinceNotice += 1;
      console.error('[commerce] database connection attempt ' + sinceNotice + '/' + MAX_ATTEMPTS + ' failed: ' + err.message);
      if (sinceNotice >= MAX_ATTEMPTS) {
        console.error(
          '[commerce] database still unavailable after ' + attempts + ' attempts; waiting ' + RETRY_DELAY_MS + 'ms before the next try (process stays alive)'
        );
        sinceNotice = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function start() {
  // Startup topology: the peer URLs and credential mode this process actually
  // resolved. Printed once and never containing a secret — a misconfigured
  // environment must be obvious from the first log line, not from unexplained
  // 403s between services later on.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'service_boot',
    service: 'commerce-service',
    services: describeServices(),
    credentials: describeCredentials(
      loadCredentials(process.env, process.env.INTERNAL_SERVICE_NAME || 'commerce')
    ),
  }));

  await connectWithRetry();
  app.listen(env.port, () => {
    console.log('[commerce] Service listening on http://localhost:' + env.port);
  });
  const orderService = require('./modules/fulfillment/services/orders.service');
  let handoffSweepRunning = false;
  const handoffSweep = async () => {
    if (handoffSweepRunning) return;
    handoffSweepRunning = true;
    try { await orderService.recoverDeliveryHandoffs(100); }
    catch (err) { console.warn('[commerce] Delivery handoff recovery failed:', err.message || err); }
    finally { handoffSweepRunning = false; }
  };
  setTimeout(handoffSweep, 5000);
  setInterval(handoffSweep, 30000).unref();
}

start().catch((err) => {
  console.error('[commerce] Failed to start:', err.message);
});
