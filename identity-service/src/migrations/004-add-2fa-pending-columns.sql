-- Add 2FA pending-setup support
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_secret VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_method VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_otp VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_phone VARCHAR(50);
