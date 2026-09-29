// RS256 key pair loader for JWT signing and JWKS distribution.
const fs = require('fs');
const path = require('path');

const keysDir = path.join(__dirname, 'keys');
const privateKeyPath = path.join(keysDir, 'private.pem');
const publicKeyPath = path.join(keysDir, 'public.pem');

let privateKey = null;
let publicKey = null;

try {
  privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  publicKey = fs.readFileSync(publicKeyPath, 'utf8');
} catch (err) {
  console.error('[keys] FATAL: RS256 key pair not found in', keysDir);
  console.error('[keys] Run: node src/config/keys/generate.js');
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
