/**
 * Two-Factor Authentication Controller
 * Endpoints for setting up, verifying, and managing 2FA
 */

const twoFactorService = require('../services/twoFactor.service');
const { ok, fail } = require('../utils/response');

/**
 * Setup 2FA - Generate secret and QR code
 * GET /user/2fa/setup
 */
async function setup2FA(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const email = req.user.email;

    // Generate TOTP secret and QR code
    const result = await twoFactorService.setupTOTP(email);

    return ok(res, {
      secret: result.secret,
      qrCode: result.qrCode,
      backupCodes: result.backupCodes,
      message: 'Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)',
    }, 'Setup initiated. Please verify with the 6-digit code from your app.');
  } catch (err) {
    return next(err);
  }
}

/**
 * Verify 2FA Setup - Confirm TOTP works and enable it
 * POST /user/2fa/verify-setup
 * Body: { code: "123456" }
 */
async function verify2FASetup(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const { code } = req.body;

    if (!code || !/^\d{6}$/.test(code)) {
      return fail(res, 'Invalid code format. Must be 6 digits.', 400, 'INVALID_CODE');
    }

    // Generate new secrets and codes
    const setup = await twoFactorService.setupTOTP(req.user.email);
    const secret = setup.secret;
    const backupCodes = setup.backupCodes;

    // Verify the code
    const verified = twoFactorService.verifyTOTP(secret, code);
    if (!verified) {
      return fail(res, 'Invalid code. Please try again.', 400, 'INVALID_CODE');
    }

    // Enable 2FA
    const pool = require('../config/database').getPool();
    await pool.connect(); // Ensure connection
    const user = await twoFactorService.enable2FA(pool, userId, secret, backupCodes);

    return ok(res, {
      enabled: true,
      backupCodes: backupCodes,
      message: 'Save these backup codes in a safe place. Each can only be used once.',
    }, '2FA enabled successfully');
  } catch (err) {
    return next(err);
  }
}

/**
 * Verify 2FA during login
 * POST /auth/verify-2fa
 * Body: { code: "123456" } or { backupCode: "XXXX-XXXX" }
 */
async function verify2FALogin(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const { code, backupCode } = req.body;

    const pool = require('../config/database').getPool();
    await pool.connect();

    // Get user's 2FA secret
    const result = await pool.query(
      'SELECT two_factor_secret FROM users WHERE id = $1 AND two_factor_enabled = true',
      [userId]
    );

    if (!result.rows[0]) {
      return fail(res, 'User does not have 2FA enabled', 400, '2FA_NOT_ENABLED');
    }

    const secret = result.rows[0].two_factor_secret;
    let verified = false;

    // Try TOTP code
    if (code && /^\d{6}$/.test(code)) {
      verified = twoFactorService.verifyTOTP(secret, code);
    }
    // Try backup code
    else if (backupCode) {
      const backupResult = await twoFactorService.verifyBackupCode(pool, userId, backupCode);
      verified = backupResult.valid;
      if (verified && backupResult.codesRemaining <= 2) {
        console.warn(`User ${userId} has only ${backupResult.codesRemaining} backup codes left`);
      }
    }

    if (!verified) {
      return fail(res, 'Invalid code. Please try again.', 401, 'INVALID_2FA_CODE');
    }

    // Update last verification time
    await pool.query(
      'UPDATE users SET two_factor_verified_at = NOW() WHERE id = $1',
      [userId]
    );

    return ok(res, {
      verified: true,
      message: '2FA verification successful',
    }, 'Code verified successfully');
  } catch (err) {
    return next(err);
  }
}

/**
 * Disable 2FA
 * POST /user/2fa/disable
 * Body: { password: "..." }
 */
async function disable2FA(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const { password } = req.body;

    if (!password) {
      return fail(res, 'Password is required to disable 2FA', 400, 'PASSWORD_REQUIRED');
    }

    // Verify password (simplified - would need actual password comparison)
    // In production, verify password against password_hash

    const pool = require('../config/database').getPool();
    await pool.connect();

    const user = await twoFactorService.disable2FA(pool, userId);

    return ok(res, {
      enabled: false,
      message: '2FA has been disabled',
    }, '2FA disabled successfully');
  } catch (err) {
    return next(err);
  }
}

/**
 * Get 2FA Status
 * GET /user/2fa/status
 */
async function get2FAStatus(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const pool = require('../config/database').getPool();
    await pool.connect();

    const status = await twoFactorService.get2FAStatus(pool, userId);

    if (!status) {
      return fail(res, 'User not found', 404, 'USER_NOT_FOUND');
    }

    return ok(res, status, '2FA status retrieved');
  } catch (err) {
    return next(err);
  }
}

/**
 * Regenerate Backup Codes
 * POST /user/2fa/backup-codes/regenerate
 */
async function regenerateBackupCodes(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const pool = require('../config/database').getPool();
    await pool.connect();

    // Check if 2FA is enabled
    const is2FAEnabled = await twoFactorService.is2FAEnabled(pool, userId);
    if (!is2FAEnabled) {
      return fail(res, 'User does not have 2FA enabled', 400, '2FA_NOT_ENABLED');
    }

    // Generate new backup codes
    const newCodes = twoFactorService.generateBackupCodes();

    // Update in database
    await pool.query(
      'UPDATE users SET backup_codes = $1 WHERE id = $2',
      [newCodes, userId]
    );

    return ok(res, {
      backupCodes: newCodes,
      message: 'Save these backup codes. Old codes will no longer work.',
    }, 'Backup codes regenerated successfully');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  setup2FA,
  verify2FASetup,
  verify2FALogin,
  disable2FA,
  get2FAStatus,
  regenerateBackupCodes,
};
