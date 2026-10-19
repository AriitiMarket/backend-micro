/**
 * Two-Factor Authentication Routes
 */

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const twoFactorController = require('../controllers/twoFactor.controller');

/**
 * Setup 2FA - Get QR code and secret
 * GET /user/2fa/setup
 */
router.get('/user/2fa/setup', authenticate, twoFactorController.setup2FA);

/**
 * Verify 2FA Setup - Confirm TOTP code
 * POST /user/2fa/verify-setup
 */
router.post('/user/2fa/verify-setup', authenticate, twoFactorController.verify2FASetup);

/**
 * Verify 2FA during login
 * POST /auth/verify-2fa
 */
router.post('/auth/verify-2fa', authenticate, twoFactorController.verify2FALogin);

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

module.exports = router;
