'use strict';
/**
 * Shared helpers for the end-to-end suites that drive the RUNNING stack through
 * the API Gateway: an HTTP caller, the real OIDC + PKCE login flow, and account
 * registration. Kept in one place so every suite signs in the same way.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

/** Read the per-caller cluster credentials from the environment or the root .env. */
function credentialMap() {
  let raw = process.env.INTERNAL_SERVICE_TOKENS || '';
  if (!raw) {
    try {
      const envFile = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '.env'), 'utf8');
      const line = /^\s*INTERNAL_SERVICE_TOKENS\s*=\s*(.+)$/m.exec(envFile);
      if (line) raw = line[1].trim().replace(/^['"]|['"]$/g, '');
    } catch (_err) { /* no root .env */ }
  }
  try { return JSON.parse(raw); } catch (_err) { return null; }
}
const TOKENS = credentialMap();

async function call(pathname, { method = 'GET', body, token, internal, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (internal) {
    h['x-internal-service'] = internal;
    h['x-internal-token'] = TOKENS[internal];
  }
  const res = await fetch(GATEWAY + pathname, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
  return { status: res.status, body: parsed };
}

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Real OIDC + PKCE sign-in: authorization code, then the token exchange. */
async function login(email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const authorize = await call('/api/auth/authorize', {
    method: 'POST',
    body: {
      client_id: 'aritii-admin-web', email, password,
      code_challenge: s256(verifier), code_challenge_method: 'S256',
    },
  });
  if (authorize.status !== 200) {
    throw new Error(`authorize failed for ${email}: ${authorize.status} ${JSON.stringify(authorize.body)}`);
  }
  const token = await call('/api/auth/token', {
    method: 'POST',
    body: {
      grant_type: 'authorization_code', code: authorize.body.code,
      code_verifier: verifier, client_id: 'aritii-admin-web',
    },
  });
  if (token.status !== 200) {
    throw new Error(`token failed for ${email}: ${token.status} ${JSON.stringify(token.body)}`);
  }
  return token.body.access_token || token.body.accessToken;
}

async function registerAccount(name, email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: {
      client_id: 'aritii-admin-web', name, email, password,
      code_challenge: s256(verifier), code_challenge_method: 'S256',
    },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.user.id;
}

module.exports = { call, login, registerAccount, s256, GATEWAY, TOKENS };
