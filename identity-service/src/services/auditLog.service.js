/**
 * Audit Log Service
 * Logs security-critical events like 2FA setup, disable, and verification attempts
 */

const log = (event, metadata = {}) => {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        event,
        ...metadata,
    };

    // In production, log to:
    // - ELK stack (Elasticsearch)
    // - CloudWatch
    // - Datadog
    // - Splunk
    // For now, use console with structured format
    console.log(`[AUDIT_LOG] ${event}`, JSON.stringify(logEntry));
};

const audit2FA = {
    /**
     * Log 2FA setup initiation
     */
    setupInitiated: (userId, method) => {
        log('2FA_SETUP_INITIATED', {
            userId,
            method,
            action: 'setup_started',
        });
    },

    /**
     * Log 2FA setup verification
     */
    setupVerified: (userId, method) => {
        log('2FA_SETUP_VERIFIED', {
            userId,
            method,
            action: 'setup_completed',
            status: 'success',
        });
    },

    /**
     * Log 2FA setup verification failure
     */
    setupVerificationFailed: (userId, method, reason = 'invalid_code') => {
        log('2FA_SETUP_VERIFICATION_FAILED', {
            userId,
            method,
            action: 'setup_verification_failed',
            reason,
            status: 'failed',
        });
    },

    /**
     * Log 2FA verification during login
     */
    verificationSuccess: (userId, method) => {
        log('2FA_VERIFICATION_SUCCESS', {
            userId,
            method,
            action: 'login_2fa_verified',
            status: 'success',
        });
    },

    /**
     * Log failed 2FA verification attempt
     */
    verificationFailed: (userId, method, reason = 'invalid_code', attempt = 1, maxAttempts = 5) => {
        log('2FA_VERIFICATION_FAILED', {
            userId,
            method,
            action: 'login_2fa_failed',
            reason,
            attempt,
            maxAttempts,
            status: 'failed',
        });
    },

    /**
     * Log rate limit exceeded
     */
    rateLimitExceeded: (userId, reason = 'too_many_attempts') => {
        log('2FA_RATE_LIMIT_EXCEEDED', {
            userId,
            action: 'rate_limit_triggered',
            reason,
            status: 'blocked',
        });
    },

    /**
     * Log 2FA disabled
     */
    disabled: (userId) => {
        log('2FA_DISABLED', {
            userId,
            action: '2fa_disabled',
            status: 'success',
        });
    },

    /**
     * Log 2FA enabled
     */
    enabled: (userId, method) => {
        log('2FA_ENABLED', {
            userId,
            method,
            action: '2fa_enabled',
            status: 'success',
        });
    },

    /**
     * Log backup code usage
     */
    backupCodeUsed: (userId) => {
        log('BACKUP_CODE_USED', {
            userId,
            action: 'backup_code_verification',
            status: 'success',
        });
    },

    /**
     * Log backup code regeneration
     */
    backupCodesRegenerated: (userId) => {
        log('BACKUP_CODES_REGENERATED', {
            userId,
            action: 'backup_codes_regenerated',
            status: 'success',
        });
    },

    /**
     * Log low backup code warning
     */
    backupCodesLow: (userId, remaining) => {
        log('BACKUP_CODES_LOW_WARNING', {
            userId,
            action: 'backup_codes_low',
            codesRemaining: remaining,
            status: 'warning',
        });
    },
};

module.exports = {
    audit2FA,
    log,
};
