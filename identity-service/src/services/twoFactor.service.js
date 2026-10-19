/**
 * Two-Factor Authentication (2FA) Service
 * Implements TOTP (Time-based One-Time Password) + Backup Codes
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

// Generate random backup codes
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

// Generate TOTP secret and QR code
async function setupTOTP(email, appName = 'Ariiti') {
  const secret = speakeasy.generateSecret({
    name: `${appName} (${email})`,
    issuer: appName,
    length: 32,
  });

  const qrCode = await QRCode.toDataURL(secret.otpauth_url);
  const backupCodes = generateBackupCodes();

  return {
    secret: secret.base32,
    qrCode,
    backupCodes,
    otpauth_url: secret.otpauth_url,
  };
}

// Verify TOTP code
function verifyTOTP(secret, code) {
  if (!secret || !code) return false;

  const verified = speakeasy.totp.verify({
    secret: secret,
    encoding: 'base32',
    token: code,
    window: 2, // Allow ±2 time windows (60 seconds total)
  });

  return verified;
}

// Verify backup code and remove it
async function verifyBackupCode(pool, userId, code) {
  // Get user's backup codes
  const result = await pool.query(
    'SELECT backup_codes FROM users WHERE id = $1',
    [userId]
  );

  if (!result.rows[0]) return { valid: false, message: 'User not found' };

  const backupCodes = result.rows[0].backup_codes || [];
  const codeIndex = backupCodes.indexOf(code);

  if (codeIndex === -1) {
    return { valid: false, message: 'Invalid backup code' };
  }

  // Remove used code
  const updatedCodes = backupCodes.filter((_, i) => i !== codeIndex);
  await pool.query(
    'UPDATE users SET backup_codes = $1 WHERE id = $2',
    [updatedCodes, userId]
  );

  const codesRemaining = updatedCodes.length;
  return {
    valid: true,
    message: 'Backup code used successfully',
    codesRemaining,
  };
}

// Enable 2FA for a user
async function enable2FA(pool, userId, secret, backupCodes) {
  const result = await pool.query(
    `UPDATE users SET 
      two_factor_enabled = true,
      two_factor_secret = $1,
      two_factor_type = 'TOTP',
      backup_codes = $2,
      two_factor_setup_at = NOW()
    WHERE id = $3
    RETURNING id, email, two_factor_enabled`,
    [secret, backupCodes, userId]
  );

  return result.rows[0];
}

// Disable 2FA for a user
async function disable2FA(pool, userId) {
  const result = await pool.query(
    `UPDATE users SET 
      two_factor_enabled = false,
      two_factor_secret = NULL,
      backup_codes = NULL,
      two_factor_setup_at = NULL,
      two_factor_verified_at = NULL
    WHERE id = $1
    RETURNING id, email, two_factor_enabled`,
    [userId]
  );

  return result.rows[0];
}

// Check if 2FA is enabled for user
async function is2FAEnabled(pool, userId) {
  const result = await pool.query(
    'SELECT two_factor_enabled FROM users WHERE id = $1',
    [userId]
  );

  return result.rows[0]?.two_factor_enabled || false;
}

// Get 2FA status
async function get2FAStatus(pool, userId) {
  const result = await pool.query(
    `SELECT 
      two_factor_enabled,
      two_factor_type,
      two_factor_setup_at,
      array_length(backup_codes, 1) as backup_codes_remaining
    FROM users WHERE id = $1`,
    [userId]
  );

  if (!result.rows[0]) return null;

  return {
    enabled: result.rows[0].two_factor_enabled,
    type: result.rows[0].two_factor_type,
    setupAt: result.rows[0].two_factor_setup_at,
    backupCodesRemaining: result.rows[0].backup_codes_remaining || 0,
  };
}

module.exports = {
  generateBackupCodes,
  setupTOTP,
  verifyTOTP,
  verifyBackupCode,
  enable2FA,
  disable2FA,
  is2FAEnabled,
  get2FAStatus,
};
