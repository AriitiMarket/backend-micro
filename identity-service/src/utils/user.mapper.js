'use strict';

/**
 * User DTO Mapper & Data Protection Utility
 *
 * Ensures sensitive security credentials (password hashes, TOTP secrets,
 * pending verification OTPs, backup codes, reset tokens) NEVER leak in API responses.
 */

const SENSITIVE_FIELDS = Object.freeze([
  'password_hash',
  'passwordHash',
  'password',
  'two_factor_secret',
  'twoFactorSecret',
  'two_factor_pending_secret',
  'twoFactorPendingSecret',
  'two_factor_pending_otp',
  'twoFactorPendingOtp',
  'two_factor_pending_expires_at',
  'twoFactorPendingExpiresAt',
  'two_factor_pending_phone',
  'twoFactorPendingPhone',
  'backup_codes',
  'backupCodes',
  'reset_token',
  'resetToken',
  'token_hash',
  'tokenHash',
  'auth_tag',
  'iv',
]);

const SENSITIVE_SET = new Set(SENSITIVE_FIELDS);

/**
 * Safely serialize a user entity for HTTP responses.
 *
 * @param {object|Array<object>|null} user - User entity or list of entities
 * @returns {object|Array<object>|null} Sanitized user representation
 */
function toUserResponse(user) {
  if (!user) return null;
  if (Array.isArray(user)) {
    return user.map((u) => toUserResponse(u));
  }
  if (typeof user !== 'object') {
    return user;
  }

  const clean = {};
  for (const [key, value] of Object.entries(user)) {
    if (SENSITIVE_SET.has(key)) {
      continue;
    }
    // Also deep sanitize nested user object if present
    if (key === 'user' && value && typeof value === 'object') {
      clean.user = toUserResponse(value);
    } else if (key === 'users' && Array.isArray(value)) {
      clean.users = value.map((u) => toUserResponse(u));
    } else {
      clean[key] = value;
    }
  }

  return clean;
}

module.exports = {
  toUserResponse,
  SENSITIVE_FIELDS,
  SENSITIVE_SET,
};
