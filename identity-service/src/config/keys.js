// RS256 key pair loader for JWT signing and JWKS distribution.
const fs = require('fs');
const path = require('path');

const keysDir = path.join(__dirname, 'keys');
const privateKeyPath = process.env.JWT_PRIVATE_KEY_PATH || path.join(keysDir, 'private.pem');
const publicKeyPath = process.env.JWT_PUBLIC_KEY_PATH || path.join(keysDir, 'public.pem');

let privateKey = null;
let publicKey = null;

try {
  privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  try {
    publicKey = fs.readFileSync(publicKeyPath, 'utf8');
  } catch {
    // The public half is safe to derive and does not need a separate secret.
    publicKey = require('crypto').createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  }
} catch (err) {
  console.error('[keys] FATAL: RS256 private key not found at', privateKeyPath);
  console.error('[keys] Set JWT_PRIVATE_KEY_PATH or create the local key pair with node src/config/keys/generate.js');
  process.exit(1);
}

// Export JWK-formatted public key for JWKS endpoint.
function getJWKS() {
  const crypto = require('crypto');
  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
  return {
    keys: [{
      ...jwk,
      kid: 'aritii-rs256-key-1',
      use: 'sig',
      alg: 'RS256',
    }],
  };
}

module.exports = { privateKey, publicKey, getJWKS };
