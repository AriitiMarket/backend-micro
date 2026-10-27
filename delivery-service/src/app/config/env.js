// Load the service's own .env for bare-metal development. The path must be
// resolved from the SERVICE ROOT (src/app/config -> ../../..), not from the
// config directory: `join(__dirname, '..', '.env')` pointed at
// src/app/.env, which never exists, so the documented .env was silently ignored
// and the process ran on defaults. Under Docker the variables already exist in
// the environment and dotenv never overrides them.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

module.exports = {
  port: process.env.PORT || 8003,
  production: process.env.NODE_ENV === 'production',
  mongodbUri: process.env.DELIVERY_MONGODB_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/aritii_delivery',
  // Service identity, peer URLs and the cluster credential live in
  // ./services.js and ../../shared/internal-auth.js — the single source of truth
  // for service-to-service topology. Nothing here may duplicate them.
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
