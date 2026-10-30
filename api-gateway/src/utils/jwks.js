// JWKS client — fetches and caches the Identity Service's public keys for RS256 verification.
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

let cachedKeys = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

function fetchJWKS() {
  const url = `${env.identityServiceUrl}/.well-known/jwks.json`;
  const parsed = new URL(url);

  // Try modern native fetch first (handles TLS, virtual-host routing, and redirects cleanly)
  if (typeof fetch === 'function') {
    return new Promise(async (resolve, reject) => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = setTimeout(() => {
        if (controller) controller.abort();
      }, 15000);

      try {
        const res = await fetch(url, {
          headers: {
            'Host': parsed.host,
            'User-Agent': 'Aritii-Gateway/1.0',
            'Accept': 'application/json',
          },
          signal: controller ? controller.signal : undefined,
          redirect: 'follow',
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
          throw new Error(`JWKS HTTP error: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.keys)) {
          throw new Error('JWKS payload missing keys array');
        }
        return resolve(data);
      } catch (err) {
        clearTimeout(timeoutId);
        // Fall back to transport.get if fetch threw
        fallbackTransportGet(url, parsed, resolve, reject);
      }
    });
  }

  return new Promise((resolve, reject) => {
    fallbackTransportGet(url, parsed, resolve, reject);
  });
}

function fallbackTransportGet(url, parsed, resolve, reject) {
  const transport = url.startsWith('https:') ? https : http;
  const req = transport.get(url, {
    timeout: 15000,
    headers: {
      'Host': parsed.host,
      'User-Agent': 'Aritii-Gateway/1.0',
      'Accept': 'application/json',
    },
  }, (res) => {
    // Handle redirect (e.g., 301, 302, 307, 308)
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const targetLocation = res.headers.location.startsWith('http')
        ? res.headers.location
        : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
      const redirectTransport = targetLocation.startsWith('https:') ? https : http;
      return redirectTransport.get(targetLocation, {
        timeout: 15000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Aritii-Gateway/1.0' },
      }, (redirRes) => {
        let redirData = '';
        redirRes.on('data', (chunk) => { redirData += chunk; });
        redirRes.on('end', () => {
          try {
            resolve(JSON.parse(redirData));
          } catch (e) {
            reject(new Error('Invalid JWKS redirect response: ' + e.message));
          }
        });
      }).on('error', reject);
    }

    if (res.statusCode !== 200) {
      return reject(new Error(`JWKS returned status ${res.statusCode}`));
    }

    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const parsedJson = JSON.parse(data);
        if (!parsedJson || !Array.isArray(parsedJson.keys)) {
          return reject(new Error('Invalid JWKS: missing keys array'));
        }
        resolve(parsedJson);
      } catch (e) {
        reject(new Error('Invalid JWKS JSON: ' + e.message));
      }
    });
  });

  req.on('timeout', () => {
    req.destroy(new Error('JWKS request timeout after 15000ms'));
  });
  req.on('error', reject);
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

let initialized = false;
let initPromise = null;

async function refreshKeys() {
  try {
    cachedKeys = await fetchJWKS();
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    const newPemCache = {};
    for (const key of (cachedKeys.keys || [])) {
      newPemCache[key.kid] = jwkToPem(key);
    }
    pemCache = Object.assign(pemCache, newPemCache);
    initialized = true;
    return true;
  } catch (e) {
    console.error('[jwks] Failed to fetch JWKS:', e.message);
    initPromise = null;
    return false;
  }
}

async function ensureKeys() {
  if (initialized && Object.keys(pemCache).length > 0) return;
  if (!initPromise) {
    initPromise = refreshKeys();
  }
  return initPromise;
}

async function verifyToken(token) {
  await ensureKeys();

  // Try to refresh if cache expired
  if (Date.now() > cacheExpiry) {
    await refreshKeys();
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new Error('Invalid token: no kid');
  }

  let pem = pemCache[decoded.header.kid];
  if (!pem) {
    // Key not found in current cache: force an on-demand refresh (e.g. Identity restarted with new key)
    console.warn(`[jwks] Key ${decoded.header.kid} not in cache; triggering on-demand refresh`);
    await refreshKeys();
    pem = pemCache[decoded.header.kid];
  }

  if (!pem) {
    throw new Error('Unknown signing key: ' + decoded.header.kid);
  }

  // Verify signature + issuer + audience. Only `type: 'access'` tokens are
  // accepted as Bearer credentials — Identity also signs `type: 'id'` tokens
  // with the same key, and those must never authorize API calls.
  let payload;
  try {
    payload = jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: env.issuer,
      audience: env.audience,
    });
  } catch (verifyErr) {
    // If signature verification failed, try refreshing the key once in case of recent rotation
    if (verifyErr.name === 'JsonWebTokenError' && verifyErr.message && verifyErr.message.includes('signature')) {
      console.warn('[jwks] Signature verification failed; refreshing key and retrying once');
      await refreshKeys();
      const freshPem = pemCache[decoded.header.kid] || pem;
      payload = jwt.verify(token, freshPem, {
        algorithms: ['RS256'],
        issuer: env.issuer,
        audience: env.audience,
      });
    } else {
      throw verifyErr;
    }
  }

  if (!payload || payload.type !== 'access') {
    throw new Error('Invalid token: access token required');
  }
  return payload;
}

module.exports = { verifyToken, fetchJWKS, ensureKeys, refreshKeys };
