/**
 * Two-Factor Authentication (2FA) Service
 * Supports 3 methods: TOTP (Google Authenticator), Email OTP, SMS OTP
 */

let speakeasy = null;
try { speakeasy = require('speakeasy'); } catch (e) { speakeasy = null; }
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { QRCode = null; }
const crypto = require('crypto');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
// const twilio = require('twilio'); // For SMS OTP (optional)

function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(base32 || '').toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < buffer.length; i++) {
    bits += buffer[i].toString(2).padStart(8, '0');
  }
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5);
    output += alphabet[parseInt(chunk.padEnd(5, '0'), 2)];
  }
  return output;
}

function computeTOTP(secretBase32, timeSec = Math.floor(Date.now() / 1000), step = 30) {
  if (speakeasy && typeof speakeasy.totp === 'function') {
    return speakeasy.totp({ secret: secretBase32, encoding: 'base32', time: timeSec });
  }
  const counter = Math.floor(timeSec / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(secretBase32);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const codeInt = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1000000;
  return codeInt.toString().padStart(6, '0');
}

// ── Cryptographic Helpers ──

const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'aritii-market-identity-2fa-encryption-key-32b!';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest(); // 32 bytes

function encryptSecret(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptSecret(encryptedText) {
  if (!encryptedText) return null;
  if (!encryptedText.startsWith('enc:v1:')) {
    // Backward compatibility with unencrypted base32 secrets
    return encryptedText;
  }
  try {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const ciphertext = parts[4];
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Failed to decrypt 2FA secret:', err.message);
    return null;
  }
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

// ── OTP Generation ──

function generateOTP(length = 6) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length);
  return crypto.randomInt(min, max).toString();
}

function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // Increased entropy: 8 hex chars (32-bit)
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

// ── TOTP (Google Authenticator) ──

async function setupTOTP(email, appName = 'Ariiti') {
  let secretBase32 = '';
  let otpauth_url = '';
  if (speakeasy && typeof speakeasy.generateSecret === 'function') {
    const secret = speakeasy.generateSecret({
      name: `${appName} (${email})`,
      issuer: appName,
      length: 32,
    });
    secretBase32 = secret.base32;
    otpauth_url = secret.otpauth_url;
  } else {
    secretBase32 = base32Encode(crypto.randomBytes(20));
    otpauth_url = `otpauth://totp/${encodeURIComponent(appName)}:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=${encodeURIComponent(appName)}`;
  }

  const qrCode = QRCode && typeof QRCode.toDataURL === 'function'
    ? await QRCode.toDataURL(otpauth_url)
    : `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><text>${otpauth_url}</text></svg>`;

  const backupCodes = generateBackupCodes();

  return {
    secret: secretBase32,
    qrCode,
    backupCodes,
    otpauth_url,
  };
}

function verifyTOTP(storedSecret, code) {
  if (!storedSecret || !code) return false;
  const rawSecret = decryptSecret(storedSecret);
  if (!rawSecret) return false;

  const normalizedCode = String(code).trim();
  if (!/^\d{6}$/.test(normalizedCode)) return false;

  // Constant-time comparison across the validity window [-1, 0, +1]
  const window = 1;
  const step = 30; // seconds
  const currentEpoch = Math.floor(Date.now() / 1000);

  for (let offset = -window; offset <= window; offset++) {
    const expected = computeTOTP(rawSecret, currentEpoch + offset * step, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(normalizedCode);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  return false;
}

// ── Email OTP ──

async function sendEmailOTP(email, otp) {
  if (!nodemailer || !process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log(`Email OTP to ${email}: ${otp} (SMTP not configured - dev mode)`);
    return true;
  }
  try {
    // Example using nodemailer (configure with your email service)
    const transporter = nodemailer.createTransport({
      // Configure based on your email provider
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER || 'noreply@ariiti.com',
        pass: process.env.EMAIL_PASSWORD || '',
      },
    });

    await transporter.sendMail({
      from: 'noreply@ariiti.com',
      to: email,
      subject: 'Your Ariiti 2FA Code',
      html: `
        <h2>Two-Factor Authentication</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing: 5px; font-family: monospace;">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
        <p>If you didn't request this, please ignore.</p>
      `,
    });

    return true;
  } catch (err) {
    console.error('Email OTP send failed:', err);
    return false;
  }
}

// ── SMS OTP ──

async function sendSMSOTP(phoneNumber, otp) {
  // In production, integrate with Twilio
  try {
    // Example: Using Twilio (requires setup)
    // const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    // await client.messages.create({
    //   body: `Your Ariiti 2FA code is: ${otp}. Expires in 10 minutes.`,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   to: phoneNumber,
    // });

    console.log(`SMS OTP to ${phoneNumber}: ${otp}`); // For testing
    return true;
  } catch (err) {
    console.error('SMS OTP send failed:', err);
    return false;
  }
}

// ── Method Selection & Setup ──

async function setupTwoFA(method, email, phoneNumber = null) {
  if (method === 'TOTP') {
    return await setupTOTP(email);
  } else if (method === 'EMAIL') {
    const otp = generateOTP();
    const sent = await sendEmailOTP(email, otp);
    if (!sent) throw new Error('Failed to send email OTP');
    return {
      method: 'EMAIL',
      otp, // Store this in database temporarily
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    };
  } else if (method === 'SMS') {
    if (!phoneNumber) throw new Error('Phone number required for SMS');
    const otp = generateOTP();
    const sent = await sendSMSOTP(phoneNumber, otp);
    if (!sent) throw new Error('Failed to send SMS OTP');
    return {
      method: 'SMS',
      otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    };
  }
  throw new Error('Invalid 2FA method');
}

// ── Verification ──

function verifyOTP(storedOTP, providedOTP, expiresAt) {
  if (!storedOTP || !providedOTP) {
    return { valid: false, message: 'Invalid OTP code.' };
  }
  if (new Date() > expiresAt) {
    return { valid: false, message: 'OTP expired. Request a new one.' };
  }
  const a = Buffer.from(String(storedOTP).trim());
  const b = Buffer.from(String(providedOTP).trim());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, message: 'Invalid OTP code.' };
  }
  return { valid: true, message: 'OTP verified.' };
}

// ── Database Operations ──

async function enable2FA(pool, userId, method, secretOrOTP, backupCodes, phoneNumber = null, destination = null) {
  // Encrypt secret if method is TOTP
  const secretToSave = method === 'TOTP' && secretOrOTP ? encryptSecret(secretOrOTP) : secretOrOTP;
  
  // Hash backup codes before storing in PostgreSQL
  const hashedBackupCodes = Array.isArray(backupCodes)
    ? backupCodes.map((c) => hashBackupCode(c))
    : [];

  const result = await pool.query(
    `UPDATE users SET 
      two_factor_enabled = true,
      two_factor_secret = $1,
      two_factor_type = $2,
      phone_number = COALESCE($3, phone_number),
      backup_codes = $4,
      two_factor_destination = $6,
      two_factor_setup_at = NOW(),
      two_factor_pending_secret = NULL,
      two_factor_pending_method = NULL,
      two_factor_pending_otp = NULL,
      two_factor_pending_expires_at = NULL,
      two_factor_pending_phone = NULL
    WHERE id = $5
    RETURNING id, email, two_factor_enabled, two_factor_type`,
    [secretToSave, method, phoneNumber, hashedBackupCodes, userId, destination]
  );

  return result.rows[0];
}

async function disable2FA(pool, userId) {
  const result = await pool.query(
    `UPDATE users SET 
      two_factor_enabled = false,
      two_factor_secret = NULL,
      two_factor_type = NULL,
      backup_codes = NULL,
      two_factor_setup_at = NULL,
      two_factor_verified_at = NULL
    WHERE id = $1
    RETURNING id, email, two_factor_enabled`,
    [userId]
  );

  return result.rows[0];
}

async function is2FAEnabled(pool, userId) {
  const result = await pool.query(
    'SELECT two_factor_enabled FROM users WHERE id = $1',
    [userId]
  );

  return result.rows[0]?.two_factor_enabled || false;
}

async function get2FAStatus(pool, userId) {
  const result = await pool.query(
    `SELECT 
      two_factor_enabled,
      two_factor_type,
      phone_number,
      two_factor_setup_at,
      array_length(backup_codes, 1) as backup_codes_remaining
    FROM users WHERE id = $1`,
    [userId]
  );

  if (!result.rows[0]) return null;

  return {
    enabled: result.rows[0].two_factor_enabled,
    type: result.rows[0].two_factor_type,
    phoneNumber: result.rows[0].phone_number,
    setupAt: result.rows[0].two_factor_setup_at,
    backupCodesRemaining: result.rows[0].backup_codes_remaining || 0,
  };
}

// ── Backup Codes ──

async function verifyBackupCode(pool, userId, candidateCode) {
  const result = await pool.query(
    'SELECT backup_codes FROM users WHERE id = $1',
    [userId]
  );

  if (!result.rows[0]) return { valid: false, message: 'User not found' };

  const backupCodes = result.rows[0].backup_codes || [];
  const normalizedCandidate = String(candidateCode).trim().toUpperCase();
  const candidateHash = hashBackupCode(normalizedCandidate);

  // Support both SHA-256 hashed backup codes and legacy unhashed codes with constant-time comparison
  let codeIndex = -1;
  const candidateHashBuf = Buffer.from(candidateHash);
  const normalizedCandidateBuf = Buffer.from(normalizedCandidate);

  for (let i = 0; i < backupCodes.length; i++) {
    const storedBuf = Buffer.from(String(backupCodes[i]));
    if (storedBuf.length === candidateHashBuf.length && crypto.timingSafeEqual(storedBuf, candidateHashBuf)) {
      codeIndex = i;
      break;
    }
    if (storedBuf.length === normalizedCandidateBuf.length && crypto.timingSafeEqual(storedBuf, normalizedCandidateBuf)) {
      codeIndex = i;
      break;
    }
  }

  if (codeIndex === -1) {
    return { valid: false, message: 'Invalid backup code' };
  }

  const updatedCodes = backupCodes.filter((_, i) => i !== codeIndex);
  await pool.query(
    'UPDATE users SET backup_codes = $1 WHERE id = $2',
    [updatedCodes, userId]
  );

  return {
    valid: true,
    message: 'Backup code used successfully',
    codesRemaining: updatedCodes.length,
  };
}

// ── Pending 2FA setup (stored between setup and verify-setup) ──

async function storePending2FA(pool, userId, { method, secret, otp, expiresAt, phoneNumber }) {
  await pool.query(
    `UPDATE users SET
       two_factor_pending_secret = $1,
       two_factor_pending_method = $2,
       two_factor_pending_otp = $3,
       two_factor_pending_expires_at = $4,
       two_factor_pending_phone = $5
     WHERE id = $6`,
    [secret || null, method, otp || null, expiresAt || null, phoneNumber || null, userId]
  );
}

async function getPending2FA(pool, userId) {
  const result = await pool.query(
    `SELECT two_factor_pending_secret, two_factor_pending_method, two_factor_pending_otp,
            two_factor_pending_expires_at, two_factor_pending_phone
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row || !row.two_factor_pending_method) return null;
  return {
    secret: row.two_factor_pending_secret,
    method: row.two_factor_pending_method,
    otp: row.two_factor_pending_otp,
    expiresAt: row.two_factor_pending_expires_at,
    phoneNumber: row.two_factor_pending_phone,
  };
}

async function clearPending2FA(pool, userId) {
  await pool.query(
    `UPDATE users SET
       two_factor_pending_secret = NULL,
       two_factor_pending_method = NULL,
       two_factor_pending_otp = NULL,
       two_factor_pending_expires_at = NULL,
       two_factor_pending_phone = NULL
     WHERE id = $1`,
    [userId]
  );
}

module.exports = {
  generateOTP,
  generateBackupCodes,
  setupTOTP,
  verifyTOTP,
  sendEmailOTP,
  sendSMSOTP,
  setupTwoFA,
  verifyOTP,
  enable2FA,
  disable2FA,
  is2FAEnabled,
  get2FAStatus,
  verifyBackupCode,
  storePending2FA,
  getPending2FA,
  clearPending2FA,
  encryptSecret,
  decryptSecret,
  hashBackupCode,
  computeTOTP,
  base32Encode,
  base32Decode,
};
