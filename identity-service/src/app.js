// Identity Service Express app — OAuth 2.1 + OIDC. No cookies, no sessions.
const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const env = require('./config/env');
const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const sellersRoutes = require('./routes/sellers.routes');
const providersRoutes = require('./routes/providers.routes');
const onboardingRoutes = require('./routes/onboarding.routes');
const agentsRoutes = require('./routes/agents.routes');
const addressesRoutes = require('./routes/addresses.routes');
const adminRoutes = require('./routes/admin.routes');
const adminRolesRoutes = require('./routes/admin-roles.routes');
const auditRoutes = require('./routes/audit.routes');
const gatewayOnly = require('./middleware/gatewayOnly');
const { requestId } = require('./shared/request-context');
const { errorHandler } = require('./middleware/errorHandler');
const { getPool } = require('./config/database');

const app = express();
// Trace id first: every log line and every error response produced while
// handling this request is correlated with the id the gateway assigned at the
// edge.
app.use(requestId);
app.use(cors({ origin: [env.corsOrigin, 'http://localhost:8000'], credentials: false }));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.get('/', function (req, res) { res.send('Identity Service is running'); });

// Liveness — is the PROCESS up? Independent of PostgreSQL on purpose: a restart
// on this signal must only ever be triggered by a broken process, never by a
// database that is merely slow to accept connections.
app.get('/health/live', function (_req, res) {
  res.status(200).json({
    success: true,
    code: 'ALIVE',
    status: 'alive',
    service: 'identity-service',
    timestamp: new Date().toISOString(),
  });
});

// Readiness — can this instance serve traffic? False while PostgreSQL is
// unreachable, which is what takes the container out of the gateway's rotation
// without anyone killing it.
app.get('/health/ready', async function (_req, res) {
  try {
    await getPool();
    res.status(200).json({
      success: true,
      code: 'READY',
      service: 'identity-service',
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      code: 'NOT_READY',
      service: 'identity-service',
      status: 'degraded',
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Liveness + DB readiness (used by compose healthchecks and the gateway).
app.get('/health', async function (req, res) {
  try {
    await getPool();
    res.status(200).json({
      success: true,
      service: 'identity-service',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      service: 'identity-service',
      status: 'degraded',
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});
// Absolute path — must match multer's UPLOAD_DIR (`src/config/../../uploads`).
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

// Everything below this line must arrive with a valid cluster credential naming
// its caller. The Identity Service publishes no port (see docker-compose), so the
// only legitimate caller for the browser-facing surface is the API Gateway — and
// without this gate any container on the private network could reach /auth,
// /user or /admin directly and bypass the edge rate limiting, the authorization
// table and identity injection. Named peer services (commerce, delivery) may
// only use the /internal/* surface, which is additionally guarded per route.
app.use(gatewayOnly);
app.use(authRoutes);
app.use(usersRoutes);
app.use(sellersRoutes);
app.use(providersRoutes);
app.use(onboardingRoutes);
app.use(agentsRoutes);
app.use(addressesRoutes);
app.use(adminRoutes);
app.use(adminRolesRoutes);
app.use(auditRoutes);
app.use(errorHandler);

module.exports = app;
