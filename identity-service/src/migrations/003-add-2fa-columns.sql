-- Add 2FA (TOTP + Backup Codes) support to users table
-- Migration: 003-add-2fa-columns.sql

-- Add 2FA columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS
  two_factor_enabled BOOLEAN DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  two_factor_secret VARCHAR(255);

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  two_factor_type VARCHAR(50) DEFAULT 'TOTP';

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  backup_codes TEXT[];

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  two_factor_setup_at TIMESTAMP;

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  two_factor_verified_at TIMESTAMP;

-- Create index for quick lookup
CREATE INDEX IF NOT EXISTS idx_users_2fa_enabled ON users(two_factor_enabled);

-- Log migration
SELECT 'Migration 003: Added 2FA columns to users table' as migration_info;
