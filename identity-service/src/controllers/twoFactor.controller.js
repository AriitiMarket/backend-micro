/**
 * Two-Factor Authentication Controller
 * Endpoints for setting up, verifying, and managing 2FA
 */

const twoFactorService = require('../services/twoFactor.service');
const authService = require('../services/auth.service');
const usersRepository = require('../repositories/users.repository');
const { comparePassword } = require('../utils/password');
const { ok, fail } = require('../utils/response');
const { audit2FA } = require('../services/auditLog.service');

/**
 * Setup 2FA - Generate secret and QR code
 * GET /user/2fa/setup
 */
async function setup2FA(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const email = req.user.email;
    const { method = 'TOTP', phoneNumber, email: destEmail } = req.body || {};
    const targetEmail = destEmail || email;

    // Dispatch to the appropriate setup flow based on the selected method
    // setupTwoFA handles TOTP, EMAIL, and SMS internally
    const result = await twoFactorService.setupTwoFA(method, targetEmail, phoneNumber || null);

    const pool = await require('../config/database').getPool();

    audit2FA.setupInitiated(userId, method);

    if (method === 'TOTP') {
      await twoFactorService.storePending2FA(pool, userId, {
        method: 'TOTP',
        secret: result.secret,
        backupCodes: result.backupCodes,
      });
      return ok(res, {
        method: 'TOTP',
        secret: result.secret,
        qrCode: result.qrCode,
        backupCodes: result.backupCodes,
        message: 'Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)',
      }, 'Setup initiated. Please verify with the 6-digit code from your app.');
    }

    await twoFactorService.storePending2FA(pool, userId, {
      method: result.method,
      otp: result.otp,
      expiresAt: result.expiresAt,
      phoneNumber: phoneNumber || destEmail || null,
    });

    // EMAIL or SMS — OTP was sent to the user
    // CRITICAL: In production, NEVER return tempOTP in response
    const responsePayload = {
      method: result.method,
      backupCodes: result.backupCodes || [],
      expiresAt: result.expiresAt,
      message: method === 'EMAIL'
        ? 'A verification code has been sent to your email. Please enter it to complete setup.'
        : 'A verification code has been sent to your phone. Please enter it to complete setup.',
    };

    // Only include tempOTP in development/testing
    if (process.env.NODE_ENV !== 'production') {
      responsePayload.tempOTP = result.otp;
      responsePayload._warning = 'tempOTP included for testing only. Remove in production!';
    }

    return ok(res, responsePayload, `${method} 2FA setup initiated.`);
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

    if (!code) {
      return fail(res, 'Code is required.', 400, 'INVALID_CODE');
    }

    const pool = await require('../config/database').getPool();

    const pending = await twoFactorService.getPending2FA(pool, userId);
    if (!pending) {
      return fail(res, 'No pending 2FA setup. Start setup first.', 400, 'NO_PENDING_SETUP');
    }

    const method = pending.method;
    let verified = false;
    let secretToStore = pending.secret;
    let backupCodes = twoFactorService.generateBackupCodes();

    if (method === 'TOTP') {
      if (!/^\d{6}$/.test(code)) {
        return fail(res, 'Invalid code format. Must be 6 digits.', 400, 'INVALID_CODE');
      }
      verified = twoFactorService.verifyTOTP(pending.secret, code);
    } else {
      const result = twoFactorService.verifyOTP(pending.otp, code, new Date(pending.expiresAt));
      verified = result.valid;
      // For EMAIL/SMS, don't store OTP as permanent secret; store null
      secretToStore = null;
    }

    if (!verified) {
      audit2FA.setupVerificationFailed(userId, method, 'invalid_code');
      return fail(res, 'Invalid code. Please try again.', 400, 'INVALID_CODE');
    }

    // Enable 2FA
    const user = await twoFactorService.enable2FA(
      pool, userId, method, secretToStore, backupCodes,
      method === 'SMS' ? pending.phoneNumber : null,
      pending.phoneNumber
    );
    await twoFactorService.clearPending2FA(pool, userId);

    audit2FA.enabled(userId, method);
    audit2FA.setupVerified(userId, method);

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

    const pool = await require('../config/database').getPool();

    // Check rate limiting
    if (req.rateLimit && req.rateLimit.isLockedOut && req.rateLimit.isLockedOut()) {
      audit2FA.rateLimitExceeded(userId, 'too_many_attempts');
      return fail(res, 'Too many failed attempts. Please try again later.', 429, 'RATE_LIMITED');
    }

    // Get user's 2FA info
    const result = await pool.query(
      'SELECT two_factor_secret, two_factor_type, two_factor_enabled FROM users WHERE id = $1 AND two_factor_enabled = true',
      [userId]
    );

    if (!result.rows[0]) {
      return fail(res, 'User does not have 2FA enabled', 400, '2FA_NOT_ENABLED');
    }

    const type = result.rows[0].two_factor_type;
    const secret = result.rows[0].two_factor_secret;
    let verified = false;
    const attempt = req.rateLimit?.getAttempts?.() || 1;

    // Try backup code
    if (backupCode) {
      const backupResult = await twoFactorService.verifyBackupCode(pool, userId, backupCode);
      verified = backupResult.valid;
      if (verified) {
        audit2FA.backupCodeUsed(userId);
        if (backupResult.codesRemaining <= 2) {
          audit2FA.backupCodesLow(userId, backupResult.codesRemaining);
        }
      }
    } else if (code) {
      if (type === 'TOTP') {
        if (!/^\d{6}$/.test(code)) {
          return fail(res, 'Invalid code format.', 400, 'INVALID_CODE');
        }
        verified = twoFactorService.verifyTOTP(secret, code);
      } else {
        // EMAIL or SMS: check pending OTP
        const pending = await twoFactorService.getPending2FA(pool, userId);
        if (pending && pending.otp) {
          const r = twoFactorService.verifyOTP(pending.otp, code, new Date(pending.expiresAt));
          verified = r.valid;
          if (verified) await twoFactorService.clearPending2FA(pool, userId);
        }
      }
    }

    if (!verified) {
      // Increment rate limit counter on failed attempt
      if (req.rateLimit && req.rateLimit.incrementAttempt) {
        req.rateLimit.incrementAttempt(true);
      }

      audit2FA.verificationFailed(userId, type, 'invalid_code', attempt, 5);
      return fail(res, 'Invalid code. Please try again.', 401, 'INVALID_2FA_CODE');
    }

    // Reset rate limit on successful verification
    if (req.rateLimit && req.rateLimit.incrementAttempt) {
      req.rateLimit.incrementAttempt(false);
    }

    // Update last verification time
    await pool.query(
      'UPDATE users SET two_factor_verified_at = NOW() WHERE id = $1',
      [userId]
    );

    // Issue tokens
    const loginResult = await authService.completeLoginAfter2FA(userId);

    audit2FA.verificationSuccess(userId, type);

    return ok(res, {
      verified: true,
      access_token: loginResult.tokens.accessToken,
      refresh_token: loginResult.tokens.refreshToken,
      id_token: loginResult.tokens.idToken,
      token_type: 'Bearer',
      expires_in: loginResult.tokens.expiresIn,
      user: loginResult.user,
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

    // CRITICAL FIX: Verify password against stored hash
    const user = await usersRepository.findById(userId);
    if (!user) {
      return fail(res, 'User not found', 404, 'USER_NOT_FOUND');
    }

    // Get the password hash for comparison
    const pool = await require('../config/database').getPool();
    const userWithPassword = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (!userWithPassword.rows[0] || !userWithPassword.rows[0].password_hash) {
      return fail(res, 'User credentials not found', 400, 'CREDENTIALS_NOT_FOUND');
    }

    const validPassword = await comparePassword(password, userWithPassword.rows[0].password_hash);
    if (!validPassword) {
      audit2FA.disabled(userId); // Log attempt even if failed
      return fail(res, 'Invalid password. 2FA not disabled.', 401, 'INVALID_PASSWORD');
    }

    const updatedPool = await require('../config/database').getPool();

    const updatedUser = await twoFactorService.disable2FA(updatedPool, userId);

    // CRITICAL: Invalidate all refresh tokens on 2FA disable
    await authService.revokeAllUserTokens(userId);

    audit2FA.disabled(userId);

    return ok(res, {
      enabled: false,
      message: '2FA has been disabled. All active sessions have been terminated for security.',
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
    const pool = await require('../config/database').getPool();

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
    const pool = await require('../config/database').getPool();

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

    audit2FA.backupCodesRegenerated(userId);

    return ok(res, {
      backupCodes: newCodes,
      message: 'Save these backup codes. Old codes will no longer work.',
    }, 'Backup codes regenerated successfully');
  } catch (err) {
    return next(err);
  }
}

/**
 * Resend 2FA code (EMAIL/SMS only)
 * POST /auth/resend-2fa-code
 */
async function resend2FACode(req, res, next) {
  try {
    const userId = req.user.sub || req.user.id;
    const { method } = req.body || {};
    if (method === 'TOTP') {
      return fail(res, 'TOTP does not need resend', 400, 'INVALID_METHOD');
    }
    const pool = await require('../config/database').getPool();
    const result = await pool.query(
      'SELECT email, phone_number, two_factor_enabled, two_factor_type FROM users WHERE id = $1',
      [userId]
    );
    if (!result.rows[0] || !result.rows[0].two_factor_enabled) {
      return fail(res, '2FA not enabled', 400, '2FA_NOT_ENABLED');
    }
    const user = result.rows[0];
    const otp = twoFactorService.generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    if (method === 'EMAIL' || user.two_factor_type === 'EMAIL') {
      await twoFactorService.sendEmailOTP(user.email, otp);
    } else {
      await twoFactorService.sendSMSOTP(user.phone_number, otp);
    }
    await twoFactorService.storePending2FA(pool, userId, {
      method: method || user.two_factor_type,
      otp,
      expiresAt,
      phoneNumber: user.phone_number,
    });
    return ok(res, { message: 'Code resent' }, 'Code resent');
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
  resend2FACode,
};
