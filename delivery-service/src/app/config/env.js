require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

module.exports = {
  port: process.env.PORT || 8003,
  production: process.env.NODE_ENV === 'production',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/aritii_delivery',
  // Service identity, peer URLs and the cluster credential live in
  // ./services.js and ../../shared/internal-auth.js — the single source of truth
  // for service-to-service topology. Nothing here may duplicate them.
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
};
