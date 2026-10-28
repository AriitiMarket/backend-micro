const express = require('express');
const cors = require('cors');
const env = require('../config/env');
const gatewayOnly = require('../middleware/gatewayOnly');
const { requestId } = require('../../shared/request-context');
const { notFound, errorHandler } = require('../middleware/errorHandler');

const locationRoutes = require('../../modules/locations-expansion/routes/locations.routes');
const expansionRoutes = require("../../modules/locations-expansion/routes/expansion.routes");
const zoneRoutes = require('../../modules/locations-expansion/routes/zones.routes');
const deliveryRouteRoutes = require('../../modules/locations-expansion/routes/deliveryRoutes.routes');
const deliveryServicesRoutes = require('../../modules/locations-expansion/routes/deliveryServices.routes');
const providerRoutes = require('../../modules/providers/routes/providers.routes');
const providerApplicationRoutes = require('../../modules/providers/routes/providerApplications.routes');
const providerWalletRoutes = require('../../modules/provider-wallet/routes/provider-wallet.routes');
const providerPayoutRoutes = require('../../modules/provider-wallet/routes/provider-payouts.routes');
const deliveryRoutes = require('../../modules/delivery-fulfillment/routes/delivery-fulfillment.routes');
const deliveryRequestRoutes = require('../../modules/delivery-fulfillment/routes/delivery-request.routes');
const assignmentRoutes = require('../../modules/operations/routes/assignments.routes');
const assignmentBatchRoutes = require('../../modules/operations/routes/assignmentBatches.routes');
const operationsRoutes = require('../../modules/operations/routes/operations.routes');
const shipmentRoutes = require('../../modules/operations/routes/shipments.routes');
const trackingRoutes = require('../../modules/tracking/routes/tracking.routes');
const internalRoutes = require('../../modules/operations/routes/internal.routes');
const portRoutes = require('../../modules/operations/routes/ports.routes');

const app = express();

// Trace id first: every log line, every error response and every outbound
// service-to-service call made while handling this request is correlated with
// the id the gateway assigned at the edge.
app.use(requestId);
const deliveryCorsOrigins = (env.corsOrigin || '*').split(',').map((o) => o.trim()).filter(Boolean);
const allowAllDeliveryCors = deliveryCorsOrigins.includes('*') || deliveryCorsOrigins.length === 0;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowAllDeliveryCors) return callback(null, true);
    if (deliveryCorsOrigins.includes(origin) || origin === 'http://localhost:8000' || origin === 'http://localhost:3000') {
      return callback(null, true);
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => res.send('Delivery Service is running'));

// Database readiness, shared by /health and /health/ready so the two can never
// disagree about whether this instance can serve traffic.
function databaseReadiness() {
  const mongoose = require('mongoose');
  const connected = mongoose.connection.readyState === 1;
  return { connected, database: connected ? 'connected' : 'disconnected' };
}

// Liveness — is the PROCESS up? Deliberately independent of the database: a
// restart on this signal must only ever be triggered by a broken process, never
// by a database that is merely slow to accept connections.
app.get('/health/live', (_req, res) => {
  res.status(200).json({
    success: true, code: 'ALIVE', status: 'alive', service: 'delivery-service',
    timestamp: new Date().toISOString(),
  });
});

// Readiness — can this instance serve traffic? False while the database is not
// connected, which is what takes it out of the gateway's rotation without anyone
// killing the container.
app.get('/health/ready', (_req, res) => {
  const state = databaseReadiness();
  res.status(state.connected ? 200 : 503).json({
    success: state.connected,
    code: state.connected ? 'READY' : 'NOT_READY',
    status: state.connected ? 'ready' : 'degraded',
    service: 'delivery-service',
    database: state.database,
    timestamp: new Date().toISOString(),
  });
});

// Backwards-compatible aggregate probe (compose healthcheck + gateway), same
// verdict as /health/ready.
app.get('/health', (_req, res) => {
  const state = databaseReadiness();
  res.status(state.connected ? 200 : 503).json({
    success: state.connected, service: 'delivery-service',
    status: state.connected ? 'healthy' : 'degraded',
    database: state.database,
    timestamp: new Date().toISOString(),
  });
});

app.use(gatewayOnly);

app.use('/delivery/location', locationRoutes);
app.use('/delivery/zone', zoneRoutes);
app.use('/delivery/port', portRoutes);
app.use('/delivery/route', deliveryRouteRoutes);
// Delivery service catalog (read + admin CRUD) — powers the Delivery Services page.
app.use('/delivery/service', deliveryServicesRoutes);
app.use('/delivery/provider', providerRoutes);
app.use('/delivery/provider-wallet', providerWalletRoutes);
app.use('/delivery/provider-payouts', providerPayoutRoutes);
// Legacy alias — this router used to be mounted at /delivery/partner, before
// the delivery actor was renamed to "provider". Same router, old prefix, so an
// already-deployed client keeps working while it is being redeployed.
app.use('/delivery/partner', providerRoutes);
// Provider application flow (public apply -> admin review -> role provisioning).
// Mounted on its own prefix — outside /delivery — so the applicant-facing surface
// is explicit and mirrors the Commerce-owned /seller-application flow.
app.use('/provider-application', providerApplicationRoutes);
app.use('/delivery/delivery', deliveryRoutes);
app.use('/delivery/request', deliveryRequestRoutes);
app.use('/delivery/assignment', assignmentRoutes);
// Multi-order assignment workflow (ready orders -> batch assign -> rider leg).
// Mounted on its own path because it also serves the rider-facing actions.
app.use('/delivery/dispatch', assignmentBatchRoutes);
app.use('/delivery/operation', operationsRoutes);
// Shipments + consolidation (line-haul) — Shipments and Consolidation pages.
app.use('/delivery/shipments', shipmentRoutes);
app.use('/delivery/tracking', trackingRoutes);
app.use('/internal/delivery', internalRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
