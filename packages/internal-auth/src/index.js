/**
 * @packages/internal-auth - Main Entry Point
 */
'use strict';

const internalAuth = require('./internal-auth');
const JWTHandler = require('./jwt');
const CredentialsManager = require('./credentials');
const RequestVerifier = require('./verification');

module.exports = {
  // Canonical service-to-service trust boundary
  ...internalAuth,

  // JWT handling
  JWTHandler,
  createToken: (payload, secret, expiresIn) => 
    JWTHandler.create(payload, secret, expiresIn),
  verifyToken: (token, secret) => 
    JWTHandler.verify(token, secret),
  decodeToken: (token) => 
    JWTHandler.decode(token),

  // Credentials Manager & RequestVerifier
  CredentialsManager,
  loadAllCredentials: () => 
    CredentialsManager.loadAllCredentials(),
  RequestVerifier,
  verifyRequest: (req, knownServices) => 
    RequestVerifier.verify(req, knownServices),
  createHeaders: (serviceName, token) => 
    RequestVerifier.createHeaders(serviceName, token),
};
