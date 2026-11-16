'use strict';

/**
 * Rate limiting middleware for authentication and 2FA verification attempts.
 * Prevents brute-force attacks on credentials, token rotation, password resets, and OTP codes.
 */

// In-memory store: userId => { attempts: number, lastAttempt: timestamp, lockedUntil: timestamp }
const attemptTracker = new Map();

const RATE_LIMIT_CONFIG = {
  twoFAVerify: {
    maxAttempts: 5,
    windowMs: 5 * 60 * 1000, // 5 minutes
    lockoutMs: 15 * 60 * 1000, // 15 minutes lockout after max attempts
  },
  authEndpoints: {
    login: { maxAttempts: 15, windowMs: 60 * 1000 },
    tokenRefresh: { maxAttempts: 60, windowMs: 60 * 1000 },
    passwordReset: { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
  },
};

/**
 * Generic sliding-window rate limiter
 */
function createRateLimiter(options = {}) {
  const maxAttempts = options.max || options.maxAttempts || 20;
  const windowMs = options.windowMs || 60 * 1000;
  const message = options.message || 'Too many requests. Please try again later.';
  const store = new Map();

  return (req, res, next) => {
    // In test environment, skip rate limits if bypassed
    if (process.env.NODE_ENV === 'test' && !req.headers['x-test-rate-limit']) {
      return next();
    }

    const key = options.keyGenerator
      ? options.keyGenerator(req)
      : (req.ip || (req.headers && req.headers['x-forwarded-for']) || req.user?.id || 'unknown');
    const now = Date.now();
    let record = store.get(key);

    if (!record || now - record.lastAttempt > windowMs) {
      record = { count: 1, lastAttempt: now };
      store.set(key, record);
      return next();
    }

    record.count++;
    if (record.count > maxAttempts) {
      const retryAfterSec = Math.ceil((windowMs - (now - record.lastAttempt)) / 1000);
      return res.status(429).json({
        success: false,
        message,
        retryAfter: retryAfterSec,
      });
    }
    next();
  };
}

/**
 * Rate limiter for 2FA verification attempts
 */
function create2FALimiter(maxAttempts = 5, windowMs = 5 * 60 * 1000, lockoutMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const userId = req.user?.sub || req.user?.id;
    if (!userId) {
      return next();
    }

    const now = Date.now();
    let tracker = attemptTracker.get(userId);

    // Initialize or reset if window expired
    if (!tracker || now - tracker.lastAttempt > windowMs) {
      tracker = {
        attempts: 0,
        lastAttempt: now,
        lockedUntil: null,
      };
      attemptTracker.set(userId, tracker);
    }

    // Check if currently locked out
    if (tracker.lockedUntil && now < tracker.lockedUntil) {
      const remainingMs = tracker.lockedUntil - now;
      const remainingSec = Math.ceil(remainingMs / 1000);
      return res.status(429).json({
        success: false,
        message: `Too many failed attempts. Please try again in ${remainingSec} seconds.`,
        retryAfter: remainingSec,
      });
    }

    // Clear lockout if window expired
    if (tracker.lockedUntil && now >= tracker.lockedUntil) {
      tracker.lockedUntil = null;
      tracker.attempts = 0;
    }

    // Attach to request for use in controller
    req.rateLimit = {
      isLimited: false,
      incrementAttempt: (failed = true) => {
        if (failed) {
          tracker.attempts++;
          tracker.lastAttempt = Date.now();

          if (tracker.attempts >= maxAttempts) {
            tracker.lockedUntil = Date.now() + lockoutMs;
          }
        } else {
          tracker.attempts = 0;
          tracker.lastAttempt = Date.now();
        }
      },
      getAttempts: () => tracker.attempts,
      isLockedOut: () => tracker.lockedUntil && Date.now() < tracker.lockedUntil,
    };

    next();
  };
}

const loginLimiter = createRateLimiter(RATE_LIMIT_CONFIG.authEndpoints.login);
const tokenRefreshLimiter = createRateLimiter(RATE_LIMIT_CONFIG.authEndpoints.tokenRefresh);
const passwordResetLimiter = createRateLimiter(RATE_LIMIT_CONFIG.authEndpoints.passwordReset);

module.exports = {
  createRateLimiter,
  create2FALimiter,
  loginLimiter,
  tokenRefreshLimiter,
  passwordResetLimiter,
  RATE_LIMIT_CONFIG,
};
