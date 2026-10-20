/**
 * Rate limiting middleware for 2FA verification attempts
 * Prevents brute-force attacks on 2FA codes
 * Uses in-memory store (in production, use Redis)
 */

// In-memory store: userId => { attempts: number, lastAttempt: timestamp, lockedUntil: timestamp }
const attemptTracker = new Map();

const RATE_LIMIT_CONFIG = {
    twoFAVerify: {
        maxAttempts: 5,
        windowMs: 5 * 60 * 1000, // 5 minutes
        lockoutMs: 15 * 60 * 1000, // 15 minutes lockout after max attempts
    },
};

/**
 * Rate limiter for 2FA verification attempts
 * @param {number} maxAttempts - max attempts allowed
 * @param {number} windowMs - time window in ms
 * @param {number} lockoutMs - lockout duration in ms after max attempts
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
                    // Success: reset counter
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

/**
 * Clean up old entries periodically (every 30 minutes)
 * Prevents memory leak from accumulated user entries
 */
function cleanupOldEntries() {
    setInterval(() => {
        const now = Date.now();
        const thirtyMinutesAgo = now - 30 * 60 * 1000;

        for (const [userId, tracker] of attemptTracker.entries()) {
            // Remove entries older than 30 minutes
            if (tracker.lastAttempt < thirtyMinutesAgo) {
                attemptTracker.delete(userId);
            }
        }
    }, 30 * 60 * 1000); // Run cleanup every 30 minutes
}

// Start cleanup on module load
cleanupOldEntries();

module.exports = {
    create2FALimiter,
    RATE_LIMIT_CONFIG,
};
