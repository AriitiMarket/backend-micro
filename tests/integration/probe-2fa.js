'use strict';
/**
 * Manual probe for the admin 2FA setup flow. Not part of the committed suite —
 * it exists to prove the POST /api/user/2fa/setup path end to end against the
 * running stack (gateway -> identity) for TOTP, EMAIL and SMS.
 *
 *   node tests/integration/probe-2fa.js
 */
const { call, login } = require('./support/gateway');
const crypto = require('node:crypto');

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin@12345';

/** Base32 decode + HMAC-SHA1 TOTP, so the probe can compute the real code. */
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

(async () => {
  let token;
  try {
    token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    console.log('LOGIN OK');
  } catch (err) {
    console.log('LOGIN FAILED:', err.message);
    process.exit(1);
  }

  for (const [method, extra] of [['TOTP', {}], ['EMAIL', {}], ['SMS', { phoneNumber: '+251911000000' }]]) {
    const res = await call('/api/user/2fa/setup', {
      method: 'POST', token, body: { method, ...extra },
    });
    console.log(`\n=== ${method} setup ===`);
    console.log('status:', res.status);
    console.log('message:', res.body && res.body.message);
    if (res.status !== 200) { console.log('raw:', JSON.stringify(res.body)); continue; }

    // The response envelope flattens `data` onto the top level.
    const data = res.body.data || res.body;
    const code = method === 'TOTP'
      ? totp(data.secret, Math.floor(Date.now() / 1000 / 30))
      : data.tempOTP;

    const verify = await call('/api/user/2fa/verify-setup', {
      method: 'POST', token, body: { method, code, phoneNumber: extra.phoneNumber },
    });
    console.log('verify status:', verify.status);
    console.log('verify message:', verify.body && verify.body.message);
    if (verify.status !== 200) console.log('verify raw:', JSON.stringify(verify.body));
  }
})();
