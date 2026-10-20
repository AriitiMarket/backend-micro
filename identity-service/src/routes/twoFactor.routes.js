/**
 * Two-Factor Authentication Routes
 */

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { create2FALimiter } = require('../middleware/rateLimiter');
const twoFactorController = require('../controllers/twoFactor.controller');

// Rate limiter for 2FA verification attempts
const verify2FALimiter = create2FALimiter(5, 5 * 60 * 1000, 15 * 60 * 1000); // 5 attempts per 5 min, 15 min lockout

/**
 * Setup 2FA - Get QR code and secret
 * GET /user/2fa/setup
 */
router.get('/user/2fa/setup', authenticate, twoFactorController.setup2FA);

/**
 * Setup 2FA - Generate secret and QR code (POST variant)
 * POST /user/2fa/setup
 * Body: { method: 'TOTP' | 'EMAIL' | 'SMS', phoneNumber?: string }
 */
router.post('/user/2fa/setup', authenticate, twoFactorController.setup2FA);

/**
 * Verify 2FA Setup - Confirm TOTP code
 * POST /user/2fa/verify-setup
 */
router.post('/user/2fa/verify-setup', authenticate, twoFactorController.verify2FASetup);

/**
 * Verify 2FA during login
 * POST /auth/verify-2fa
 * Rate-limited to prevent brute force attacks
 */
router.post('/auth/verify-2fa', authenticate, verify2FALimiter, twoFactorController.verify2FALogin);

/**
 * Get 2FA Status
 * GET /user/2fa/status
 */
router.get('/user/2fa/status', authenticate, twoFactorController.get2FAStatus);

/**
 * Disable 2FA
 * POST /user/2fa/disable
 */
router.post('/user/2fa/disable', authenticate, twoFactorController.disable2FA);

/**
 * Regenerate Backup Codes
 * POST /user/2fa/backup-codes/regenerate
 */
router.post('/user/2fa/backup-codes/regenerate', authenticate, twoFactorController.regenerateBackupCodes);

/**
 * Resend 2FA code (EMAIL/SMS only)
 * POST /auth/resend-2fa-code
 */
router.post('/auth/resend-2fa-code', authenticate, twoFactorController.resend2FACode);

module.exports = router;
