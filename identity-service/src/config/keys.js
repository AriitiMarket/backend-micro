// RS256 key pair loader for JWT signing and JWKS distribution.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const keysDir = path.join(__dirname, 'keys');
const privateKeyPath = process.env.JWT_PRIVATE_KEY_PATH || path.join(keysDir, 'private.pem');
const publicKeyPath = process.env.JWT_PUBLIC_KEY_PATH || path.join(keysDir, 'public.pem');

let privateKey = null;
let publicKey = null;

function normalizePem(val) {
  if (!val) return null;
  let str = String(val).trim();
  if (str.startsWith('LS0t') || (!str.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(str))) {
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) str = decoded;
    } catch (_err) {}
  }
  return str.replace(/\\n/g, '\n');
}

// 1. Direct environment variable (e.g., container secrets or cloud env)
if (process.env.JWT_PRIVATE_KEY) {
  privateKey = normalizePem(process.env.JWT_PRIVATE_KEY);
  if (process.env.JWT_PUBLIC_KEY) {
    publicKey = normalizePem(process.env.JWT_PUBLIC_KEY);
  } else {
    publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  }
} else if (fs.existsSync(privateKeyPath) && !fs.statSync(privateKeyPath).isDirectory()) {
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    try {
      publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    } catch {
      // The public half is safe to derive and does not need a separate secret.
      publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    }
  } catch (err) {
    console.error('[keys] Error reading RS256 key pair at', privateKeyPath, err.message);
  }
}

// 2. Fallback auto-generation: prevents container crash loop on clean repository clone
if (!privateKey) {
  console.warn('[keys] WARNING: RS256 private key not found at', privateKeyPath);
  console.warn('[keys] Auto-generating ephemeral RS256 key pair so service can start on clean clone...');
  try {
    const generated = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = generated.privateKey;
    publicKey = generated.publicKey;

    try {
      fs.mkdirSync(keysDir, { recursive: true });
      fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
      fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });
      console.log('[keys] Successfully persisted generated RS256 key pair to', keysDir);
    } catch (_writeErr) {
      console.warn('[keys] Keys directory not writable; maintaining generated key pair in memory.');
    }
  } catch (genErr) {
    console.error('[keys] FATAL: Failed to generate fallback RS256 key pair:', genErr.message);
    process.exit(1);
  }
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
