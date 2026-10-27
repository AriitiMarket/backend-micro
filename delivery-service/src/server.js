const app = require('./app/routes/app');
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
      console.log('[delivery] database connected after ' + attempts + ' attempt(s)');
      return;
    } catch (err) {
      sinceNotice += 1;
      console.error(`[delivery] DB attempt ${sinceNotice}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (sinceNotice >= MAX_ATTEMPTS) {
        console.error(
          `[delivery] database still unavailable after ${attempts} attempts; waiting ${RETRY_DELAY_MS}ms before the next try (process stays alive)`
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
    service: 'delivery-service',
    services: describeServices(),
    credentials: describeCredentials(
      loadCredentials(process.env, process.env.INTERNAL_SERVICE_NAME || 'delivery')
    ),
  }));

  const server = app.listen(env.port, () => {
    console.log(`[delivery] Listening on http://localhost:${env.port}`);
  });
  const shutdown = () => {
    server.close(() => {
      require('mongoose').connection.close(false).then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await connectWithRetry();
  console.log('[delivery] Database ready');
  const deliveryOutbox = require('./modules/delivery-fulfillment/services/delivery-outbox.service');
  let outboxDrainRunning = false;
  const drainDeliveryOutbox = async () => {
    if (outboxDrainRunning) return;
    outboxDrainRunning = true;
    try { await deliveryOutbox.drain(50); }
    catch (err) { console.warn('[delivery] Outbox drain failed:', err.message || err); }
    finally { outboxDrainRunning = false; }
  };
  setTimeout(drainDeliveryOutbox, 2000);
  setInterval(drainDeliveryOutbox, 2000).unref();
  // Sweep expired provider offers so they no longer hold a delivery hostage.
  if (process.env.NODE_ENV !== 'test') {
    const assignmentsService = require('./modules/operations/services/assignments.service');
    setInterval(() => {
      assignmentsService.expireStaleOffers().catch((e) => console.warn('[assignments] expiry sweep:', e.message));
    }, 60 * 1000).unref();
  }
}

start().catch((err) => {
  console.error('[delivery] Failed to start:', err.message);
});
