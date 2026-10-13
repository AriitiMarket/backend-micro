/**
 * @aritii/internal-auth - Main Entry Point
 */

const JWTHandler = require('./jwt');
const CredentialsManager = require('./credentials');
const RequestVerifier = require('./verification');

module.exports = {
  // JWT handling
  JWTHandler,
  createToken: (payload, secret, expiresIn) => 
    JWTHandler.create(payload, secret, expiresIn),
  verifyToken: (token, secret) => 
    JWTHandler.verify(token, secret),
  decodeToken: (token) => 
    JWTHandler.decode(token),
  maskToken: (token) => 
    JWTHandler.maskToken(token),

  // Credentials
  CredentialsManager,
  loadCredentials: (serviceName) => 
    CredentialsManager.loadCredentials(serviceName),
  loadAllCredentials: () => 
    CredentialsManager.loadAllCredentials(),

  // Verification
  RequestVerifier,
  verifyRequest: (req, knownServices) => 
    RequestVerifier.verify(req, knownServices),
  createHeaders: (serviceName, token) => 
    RequestVerifier.createHeaders(serviceName, token)
};
