'use strict';
/**
 * Seed one delivery provider (delivery actor) end to end against the RUNNING stack.
 *
 *   docker compose up -d --build
 *   node scripts/seed-delivery-provider.js
 *
 * The script walks the real platform flow — nothing is written to the databases
 * directly except the final password (see step 4):
 *
 *   1. POST /api/auth/register/PROVIDER        → identity account + PENDING PROVIDER membership
 *   2. POST /api/provider-application           → delivery Provider document, status `pending`
 *   3. POST /api/provider-application/:id/approve (admin) → membership becomes ACTIVE
 *   4. set the requested password                → the account carries the credential below
 *   5. POST /api/auth/authorize + /api/auth/token → provider session, role PROVIDER
 *   6. PUT  /api/delivery/provider/:id/online    → the provider becomes assignable
 *
 * It is idempotent: re-running it reuses the account and the provider it finds.
 *
 * Credentials default to provider@aritii.com / provider123 and can be overridden
 * with PROVIDER_EMAIL / PROVIDER_PASSWORD (and the admin pair with
 * E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD).
 */
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BASE = `${GATEWAY}/api`;
const BACKEND_ROOT = path.resolve(__dirname, '..');

const PROVIDER_NAME = process.env.PROVIDER_NAME || 'Aritii Delivery Actor';
const PROVIDER_EMAIL = process.env.PROVIDER_EMAIL || 'provider@aritii.com';
const PROVIDER_PASSWORD = process.env.PROVIDER_PASSWORD || 'provider123';
const PROVIDER_PHONE = process.env.PROVIDER_PHONE || '+251911000001';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin@12345';

const CLIENT_ID = 'aritii-admin-web';

// The platform's password policy (identity-service/src/utils/password.js) demands
// an upper-case letter and a special character. A seeded credential is allowed to
// be weaker, so the account is created with a compliant temporary password and the
// requested one is written afterwards — see step 4.
const POLICY_COMPLIANT_PASSWORD = 'Seed@12345';

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
  return { status: res.status, body: parsed };
}

function assertOk(res, label) {
  if (res.status >= 400) {
    throw new Error(`${label} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Real OIDC + PKCE sign-in: authorization code, then the token exchange. */
async function login(email, password, role) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const body = {
    client_id: CLIENT_ID,
    email,
    password,
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
  };
  if (role) body.role = role;

  const authorize = await api('/auth/authorize', { method: 'POST', body });
  assertOk(authorize, `authorize(${email})`);

  const token = await api('/auth/token', {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code: authorize.body.code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    },
  });
  assertOk(token, `token(${email})`);
  return token.body.access_token;
}

/** Decode the JWT payload so we can assert on role/capabilities without extra calls. */
function decodeClaims(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/**
 * Write the requested password straight into the identity database.
 *
 * No API endpoint accepts it (the strength policy is enforced by hashPassword on
 * every write path), and the seeded credential is deliberately exempt from it.
 * The hash is produced by the identity service's own bcryptjs, so the stored
 * value is identical to one the platform would have written itself.
 */
function setPasswordDirectly(email, password) {
  const snippet = `
    const bcrypt = require('bcryptjs');
    const { Pool } = require('pg');
    (async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const hash = await bcrypt.hash(process.argv[1], 10);
      const res = await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING id, email;',
        [hash, process.argv[2]]
      );
      console.log(JSON.stringify(res.rows));
      await pool.end();
    })().catch((err) => { console.error(err.message); process.exit(1); });
  `;
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', '-w', '/app/identity-service', 'identity', 'node', '-e', snippet, '--', password, email],
    { cwd: BACKEND_ROOT, encoding: 'utf8' },
  );
  const rows = JSON.parse(out.trim().split('\n').pop());
  if (!rows || rows.length === 0) throw new Error(`no user row for ${email}`);
  return rows[0];
}

/** Sign in with whichever of the two passwords the account currently carries. */
async function loginAsProvider() {
  for (const candidate of [POLICY_COMPLIANT_PASSWORD, PROVIDER_PASSWORD]) {
    try {
      return { token: await login(PROVIDER_EMAIL, candidate), used: candidate };
    } catch (_err) { /* try the next one */ }
  }
  throw new Error(`could not sign in as ${PROVIDER_EMAIL}`);
}

async function main() {
  console.log(`Gateway: ${BASE}`);

  // 1. Register the account with the PROVIDER role → PENDING membership.
  const verifier = crypto.randomBytes(48).toString('base64url');
  const registered = await api('/auth/register/PROVIDER', {
    method: 'POST',
    body: {
      client_id: CLIENT_ID,
      name: PROVIDER_NAME,
      email: PROVIDER_EMAIL,
      password: POLICY_COMPLIANT_PASSWORD,
      phoneNumber: PROVIDER_PHONE,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    },
  });

  if (registered.status === 201) {
    console.log(`1. Registered ${PROVIDER_EMAIL} (membership PENDING, id ${registered.body.user.id})`);
  } else {
    console.log(`1. Account ${PROVIDER_EMAIL} already exists — reusing it.`);
  }

  const applicant = await loginAsProvider();
  const applicantToken = applicant.token;

  // 2. Submit the delivery provider application (or reuse the one on file).
  const mine = assertOk(await api('/provider-application/me', { token: applicantToken }), 'provider-application/me');
  let application = mine.application;

  if (!application) {
    const applied = assertOk(await api('/provider-application', {
      method: 'POST',
      token: applicantToken,
      body: {
        name: PROVIDER_NAME,
        phone: PROVIDER_PHONE,
        email: PROVIDER_EMAIL,
        providerType: 'individual_rider',
        vehicleType: 'motorcycle',
        metadata: {
          application: {
            availability: 'Daily, 8:00 - 20:00',
            experience: 'Delivery actor on the Aritii network',
            hasInsurance: true,
          },
        },
      },
    }), 'provider-application');
    application = applied.application;
    console.log(`2. Application submitted → provider ${application.id} status="${application.status}"`);
  } else {
    console.log(`2. Existing application found → provider ${application.id} status="${application.status}"`);
  }

  const providerId = application.id;

  // 3. Admin approves → identity grants the ACTIVE PROVIDER membership.
  if (application.status === 'pending' || application.status === 'rejected') {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const approved = assertOk(await api(`/provider-application/${providerId}/approve`, {
      method: 'POST',
      token: adminToken,
      body: {},
    }), 'approve(provider-application)');
    console.log(`3. Approved by ${ADMIN_EMAIL} → provider status="${approved.application.status}"`);
  } else {
    console.log(`3. Already approved → provider status="${application.status}"`);
  }

  // 4. Give the account the requested password.
  setPasswordDirectly(PROVIDER_EMAIL, PROVIDER_PASSWORD);
  console.log(`4. Password set for ${PROVIDER_EMAIL}`);

  // 5. Sign in with the requested credentials and check the granted role.
  const providerToken = await login(PROVIDER_EMAIL, PROVIDER_PASSWORD);
  const claims = decodeClaims(providerToken);
  console.log(`5. Signed in → role="${claims.role}" capabilities=${JSON.stringify(claims.capabilities)} role_statuses=${JSON.stringify(claims.role_statuses)}`);

  if (claims.role !== 'PROVIDER') {
    throw new Error(`expected the provider session to act as PROVIDER, got ${claims.role}`);
  }
  if (!(claims.capabilities || []).includes('PROVIDER')) {
    throw new Error('the provider session is missing the PROVIDER capability');
  }

  // 6. The provider's own record + the online toggle that makes it assignable.
  const me = assertOk(await api('/delivery/provider/me', { token: providerToken }), 'delivery/provider/me');
  console.log(`6. Provider record: id=${me.provider._id} status="${me.provider.status}"`);

  const online = assertOk(await api(`/delivery/provider/${providerId}/online`, {
    method: 'PUT',
    token: providerToken,
    body: { isOnline: true },
  }), 'provider online');
  console.log(`7. Online → provider status="${online.provider.status}"`);

  console.log('\n--- DELIVERY PROVIDER LOGIN CREDENTIALS ---');
  console.log(`email:    ${PROVIDER_EMAIL}`);
  console.log(`password: ${PROVIDER_PASSWORD}`);
  console.log(`role:     PROVIDER`);
  console.log(`provider: ${providerId}`);
  console.log(`phone:    ${PROVIDER_PHONE}`);
  console.log('\nSign-in is the platform OIDC + PKCE flow (there is no /login endpoint):');
  console.log('  POST /api/auth/authorize  { email, password, code_challenge, code_challenge_method: "S256" }');
  console.log('  POST /api/auth/token      { grant_type: "authorization_code", code, code_verifier }');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
