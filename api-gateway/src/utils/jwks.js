// JWKS client — fetches and caches the Identity Service's public keys for RS256 verification.
const http = require('http');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

let cachedKeys = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

function fetchJWKS() {
  return new Promise((resolve, reject) => {
    const url = `${env.identityServiceUrl}/.well-known/jwks.json`;
    http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JWKS')); }
      });
    }).on('error', reject);
  });
}

function jwkToPem(jwk) {
  const crypto = require('crypto');
  const jwkCopy = { ...jwk };
  delete jwkCopy.kid;
  delete jwkCopy.use;
  delete jwkCopy.alg;
  const pubKey = crypto.createPublicKey({ key: jwkCopy, format: 'jwk' });
  return pubKey.export({ type: 'spki', format: 'pem' });
}

let pemCache = {};

// Synchronous verification using cached PEM keys.
// On first call, fetches JWKS via a blocking init.
let initialized = false;
let initPromise = null;

async function ensureKeys() {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        cachedKeys = await fetchJWKS();
        cacheExpiry = Date.now() + CACHE_TTL_MS;
        // Pre-cache all PEM keys
        for (const key of (cachedKeys.keys || [])) {
          pemCache[key.kid] = jwkToPem(key);
        }
        initialized = true;
      } catch (e) {
        console.error('[jwks] Failed to fetch JWKS:', e.message);
        // Clear the memoised promise so the NEXT request retries. Previously the
        // rejected promise was cached forever, so an Identity Service that was
        // briefly unavailable at startup left the gateway unable to verify any
        // token until it was restarted.
        initPromise = null;
      }
    })();
  }
  return initPromise;
}

async function verifyToken(token) {
  await ensureKeys();

  // Try to refresh if cache expired
  if (Date.now() > cacheExpiry) {
    try {
      cachedKeys = await fetchJWKS();
      cacheExpiry = Date.now() + CACHE_TTL_MS;
      for (const key of (cachedKeys.keys || [])) {
        pemCache[key.kid] = jwkToPem(key);
      }
    } catch (e) {
      // Use stale cache
    }
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new Error('Invalid token: no kid');
  }
  const pem = pemCache[decoded.header.kid];
  if (!pem) throw new Error('Unknown signing key: ' + decoded.header.kid);

  // Verify signature + issuer + audience. Only `type: 'access'` tokens are
  // accepted as Bearer credentials — Identity also signs `type: 'id'` tokens
  // with the same key, and those must never authorize API calls.
  const payload = jwt.verify(token, pem, {
    algorithms: ['RS256'],
    issuer: env.issuer,
    audience: env.audience,
  });
  if (!payload || payload.type !== 'access') {
    throw new Error('Invalid token: access token required');
  }
  return payload;
}

module.exports = { verifyToken, fetchJWKS, ensureKeys };
