const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const env = require('./config/env');
const gatewayOnly = require('./middleware/gatewayOnly');
const { requestId } = require('../shared/request-context');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const shopsRoutes = require('../modules/selling/routes/shops.routes');
const productsRoutes = require('../modules/catalog/routes/products.routes');
const categoriesRoutes = require('../modules/catalog/routes/categories.routes');
const ordersRoutes = require('../modules/fulfillment/routes/orders.routes');
const adminOrdersRoutes = require('../modules/fulfillment/routes/admin.orders.routes');
const cartRoutes = require('../modules/carts/routes/carts.routes');
const wishlistRoutes = require('../modules/carts/routes/wishlists.routes');
const eventsRoutes = require('../modules/promotions/routes/events.routes');
const conversationsRoutes = require('../modules/chat/routes/conversations.routes');
const messagesRoutes = require('../modules/chat/routes/messages.routes');
const paymentsRoutes = require('../modules/fulfillment/routes/payments.routes');
const subscriptionsRoutes = require('../modules/selling/routes/subscriptions.routes');
const sectorsRoutes = require('../modules/selling/routes/sectors.routes');
const sellerApplicationsRoutes = require('../modules/selling/routes/sellerApplications.routes');
const deliveryWebhookRoutes = require('../modules/fulfillment/routes/deliveryWebhook.routes');
const paymentWebhookRoutes = require('../modules/fulfillment/routes/paymentWebhook.routes');
const analyticsRoutes = require('../modules/platform/routes/analytics.routes');
const settingsRoutes = require('../modules/platform/routes/settings.routes');
const disputesRoutes = require('../modules/fulfillment/routes/disputes.routes');
const allocationRoutes = require('../modules/fulfillment/routes/allocation.routes');
const reviewsRoutes = require('../modules/catalog/routes/reviews.routes');
const promotionsRoutes = require('../modules/promotions/routes/promotions.routes');
const requestsRoutes = require('../modules/requests/routes/requests.routes');
const adminPlatformRoutes = require('../modules/platform/routes/adminPlatform.routes');

const app = express();
// Trace id first: every log line, every error response and every outbound
// service-to-service call made while handling this request is correlated with
// the id the gateway assigned at the edge.
app.use(requestId);
// Token-based only: no cookies, therefore no credentialed CORS and no CSRF
// surface. `credentials` stays false on purpose.
app.use(cors({ origin: [env.corsOrigin, 'http://localhost:8000'], credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Commerce Service is running'));

// Database readiness, shared by /health and /health/ready so the two can never
// disagree about whether this instance can serve traffic.
function databaseReadiness() {
  const mongoose = require('mongoose');
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const connected = mongoose.connection.readyState === 1;
  return { connected, database: states[mongoose.connection.readyState] || 'unknown' };
}

// Liveness — is the PROCESS up? Deliberately independent of the database: a
// restart on this signal must only ever be triggered by a broken process, never
// by a database that is merely slow to accept connections.
app.get('/health/live', (req, res) => {
  res.status(200).json({
    success: true, code: 'ALIVE', status: 'alive', service: 'commerce-service',
    timestamp: new Date().toISOString(),
  });
});

// Readiness — can this instance serve traffic? False while the database is not
// connected, which is what takes it out of the gateway's rotation without anyone
// killing the container.
app.get('/health/ready', (req, res) => {
  const state = databaseReadiness();
  res.status(state.connected ? 200 : 503).json({
    success: state.connected,
    code: state.connected ? 'READY' : 'NOT_READY',
    status: state.connected ? 'ready' : 'degraded',
    service: 'commerce-service',
    database: state.database,
    timestamp: new Date().toISOString(),
  });
});

// Backwards-compatible aggregate probe (compose healthcheck + gateway), same
// verdict as /health/ready.
app.get('/health', (req, res) => {
  const state = databaseReadiness();
  res.status(state.connected ? 200 : 503).json({
    success: state.connected,
    service: 'commerce-service',
    status: state.connected ? 'healthy' : 'degraded',
    database: state.database,
    timestamp: new Date().toISOString(),
  });
});
// Same directory multer writes to (`src/app/config/../../uploads` → `src/uploads`).
// A relative `express.static('uploads')` resolved against WORKDIR `/app` and
// 404'd every real product image. Also mount the legacy `/app/uploads` tree so
// older seed assets keep working.
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const LEGACY_UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/uploads', express.static(LEGACY_UPLOADS_DIR));

// Everything below this line is reachable only through the API Gateway, which
// presents the cluster credential. Direct calls to this service are rejected.
app.use(gatewayOnly);

app.use('/shop', shopsRoutes);
app.use('/product', productsRoutes);
app.use('/category', categoriesRoutes);
app.use('/order', ordersRoutes);
app.use('/order', adminOrdersRoutes);
app.use('/cart', cartRoutes);
app.use('/wishlist', wishlistRoutes);
app.use('/event', eventsRoutes);
app.use('/conversation', conversationsRoutes);
app.use('/message', messagesRoutes);
app.use('/payment', paymentsRoutes);
app.use('/payment', allocationRoutes);
app.use('/subscription', subscriptionsRoutes);
app.use('/sector', sectorsRoutes);
app.use('/seller-application', sellerApplicationsRoutes);
// Delivery → Commerce status sync.
//
// INTERNAL ONLY. This used to be mounted on the public path `/delivery-webhook`
// (which the gateway forwarded to the internet), with no authenticate/authorize
// on the route: anybody who knew an order id could POST status=delivered or
// status=cancelled and change a live order. It now lives behind the cluster
// credential (`/internal/*`), which the gateway enforces at the edge and this
// service re-checks in gatewayOnly.
app.use('/internal/commerce/delivery-webhook', deliveryWebhookRoutes);
app.use('/internal/commerce/payment-webhook', paymentWebhookRoutes);

app.use('/disputes', disputesRoutes);
app.use('/review', reviewsRoutes);
app.use('/promotion', promotionsRoutes);
app.use('/request', requestsRoutes);
app.use('/admin', adminPlatformRoutes);
app.use('/', analyticsRoutes);
app.use('/', settingsRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
