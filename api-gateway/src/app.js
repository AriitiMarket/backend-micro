const http = require('http');
const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const corsConfig = require('./config/cors');
const requestId = require('./middleware/requestId');
const requestLogger = require('./middleware/requestLogger');
const identify = require('./middleware/identify');
const authorizeRequest = require('./middleware/authorizeRequest');
const { apiLimiter, authLimiter } = require('./middleware/rateLimiter');
const { enforceHttps, securityHeaders } = require('./middleware/security');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const attachSocket = require('./socket');
const { checkAll } = require('./utils/health');
const availability = require('./utils/serviceAvailability');
const {
  services,
  describeServices,
  describeCredentials,
} = require('./config/services');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger/swagger');

const app = express();
app.set('trust proxy', 1);

// TLS is mandatory in production (OAuth 2.1); browsers are pinned to https.
app.use(enforceHttps);
app.use(securityHeaders);
app.use(cors(corsConfig));
app.use(express.json());
app.use(requestId);
app.use(requestLogger);

const DOWNSTREAMS = [services.identity, services.commerce, services.delivery];

app.get('/', (req, res) => res.send('Aritii Market API Gateway is running'));

// Liveness — is the PROCESS up? It deliberately never touches a downstream
// service, so an orchestrator restarting on this signal can only ever be
// reacting to the gateway itself, never to a peer being slow or down.
app.get('/health/live', (req, res) => {
  res.status(200).json({
    success: true, code: 'ALIVE', status: 'alive', service: 'api-gateway',
    timestamp: new Date().toISOString(),
  });
});

// Readiness — can the gateway actually serve traffic? It is a pure proxy, so it
// is ready exactly when every service it routes to is ready. The process stays
// up (see liveness above) while this reports 503, which is how a load balancer
// takes it out of rotation without anyone killing the container.
app.get('/health/ready', async (req, res) => {
  const report = await checkAll(DOWNSTREAMS, env.healthProbeTimeoutMs);
  res.status(report.ready ? 200 : 503).json({
    success: report.ready,
    code: report.ready ? 'READY' : 'NOT_READY',
    status: report.ready ? 'ready' : 'degraded',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    services: report.services,
    unavailable: availability.snapshot(),
  });
});

// Aggregated report — every downstream service the gateway routes to. Always
// answers 200 (it is a report, not a gate) so existing uptime tooling keeps
// working; use /health/ready for the machine signal and /health/live for
// "is the process up".
app.get('/health', async (req, res) => {
  try {
    const report = await checkAll(DOWNSTREAMS, env.healthProbeTimeoutMs);
    res.status(200).json({
      success: true, code: 'HEALTHY', status: 'healthy',
      timestamp: new Date().toISOString(),
      services: report.services,
      unavailable: availability.snapshot(),
    });
  } catch (err) {
    res.status(503).json({
      success: false, code: 'DEGRADED', status: 'degraded',
      timestamp: new Date().toISOString(), message: err.message,
    });
  }
});

// Interactive API documentation (OAuth 2.1 flow + endpoint reference).
// Mounted before the proxy/limiter so /api/docs is not treated as an upstream path.
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));

// Service-to-service realtime ingest (commerce → socket fan-out). Cluster
// credential only; mounted at the root like the other /internal/* routes so it
// never collides with the /api proxy table.
const requireInternalToken = require('./middleware/requireInternalToken');
const { emitRequestEvent } = require('./socket/emit');
app.post('/internal/realtime/emit', requireInternalToken, emitRequestEvent);

// Credential / token endpoints get the strict limiter (per endpoint + IP).
const AUTH_ENDPOINTS = [
  '/api/auth/authorize',
  '/api/auth/register',
  '/api/auth/register/:role',
  '/api/auth/token',
  '/api/auth/refresh',
];
for (const endpoint of AUTH_ENDPOINTS) {
  app.use(endpoint, authLimiter);
}

// Identity is resolved (never required) before the general limiter so the
// authenticated ceiling can be applied.
app.use('/api', identify, apiLimiter);

// Authorization — the single decision point for privileged routes. It runs after
// the limiter (so an unauthenticated flood is still rate-limited) and before the
// proxy, which only relays coarse identity downstream. Paths with no entry in
// authorizeRequest's table are untouched.
app.use('/api', authorizeRequest);

// Pure proxy.
app.use('/api', routes);

// OIDC discovery/JWKS at the issuer root. Standard clients fetch
// `{issuer}/.well-known/...` without an /api prefix; the SPA uses the
// /api-prefixed aliases above. Rewrite onto the same routes table so
// there is one dispatch path.
app.use('/.well-known', apiLimiter, (req, res, next) => {
  // Restore the mount prefix so routes.js can match its '/.well-known' entry.
  req.url = `${req.baseUrl}${req.url}`;
  next();
}, routes);

// Media at the gateway origin as well (`{origin}/uploads/…`), not only under
// `/api/uploads/…`. Stored image paths are root-relative `/uploads/…`, so
// without this mount a bare URL (or <img src="/uploads/x.png">) 404'd.
// Restore the full path (same pattern as /.well-known) so routes.js matches
// its '/uploads' entry — do NOT prefix '/api' here, or matchTarget misses.
app.use('/uploads', apiLimiter, (req, res, next) => {
  req.url = `${req.baseUrl}${req.url}`;
  next();
}, routes);

app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);

// Startup topology log — records the peer URLs and the credential mode the
// process actually resolved (never a credential value), so a misconfigured
// environment is obvious from the first log line instead of surfacing later as
// unexplained 403s between services.
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: 'info',
  event: 'gateway_boot',
  services: describeServices(),
  credentials: describeCredentials(),
}));

// attachSocket takes a list of allowed origins (CORS_ORIGIN may be a list).
const socketOrigins = env.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
attachSocket(server, socketOrigins);

module.exports = { app, server };
