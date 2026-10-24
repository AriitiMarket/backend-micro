// Password Reset Service — secure token generation, verification, and reset execution.
const crypto = require('crypto');
const usersRepository = require('../repositories/users.repository');
const passwordResetsRepo = require('../repositories/passwordResets.repository');
const refreshTokensRepo = require('../repositories/refreshTokens.repository');
const { hashPassword } = require('../utils/password');
const env = require('../config/env');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

const RESET_TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken).trim()).digest('hex');
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

async function sendResetEmail({ email, name, resetLink }) {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASSWORD;
  const isSmtpConfigured =
    nodemailer &&
    emailUser &&
    emailPass &&
    !emailPass.includes('your-gmail') &&
    !emailPass.includes('replace-with');

  if (!isSmtpConfigured) {
    console.log(`\n======================================================`);
    console.log(`[PASSWORD RESET] Email to: ${email}`);
    console.log(`[PASSWORD RESET] Reset Link: ${resetLink}`);
    console.log(`[PASSWORD RESET] Link expires in 15 minutes.`);
    console.log(`======================================================\n`);
    return true;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    await transporter.sendMail({
      from: `"Ariiti Market" <${emailUser}>`,
      to: email,
      subject: 'Reset Your Ariiti Market Password',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #ffffff; border-radius: 12px; border: 1px solid #eaeaea;">
          <h2 style="color: #111827; margin-bottom: 16px;">Password Reset Request</h2>
          <p style="color: #4b5563; font-size: 15px; line-height: 1.5;">Hello ${name || 'User'},</p>
          <p style="color: #4b5563; font-size: 15px; line-height: 1.5;">We received a request to reset your password for your Ariiti Market account. Click the button below to set a new password:</p>
          <div style="margin: 28px 0; text-align: center;">
            <a href="${resetLink}" style="background-color: #f59e0b; color: #111827; font-weight: 700; padding: 12px 28px; border-radius: 8px; text-decoration: none; display: inline-block; font-size: 14px;">Reset Password</a>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">This link will expire in 15 minutes. If you did not request a password reset, you can safely ignore this email — your account remains secure.</p>
          <hr style="border: none; border-top: 1px solid #eaeaea; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 11px;">Ariiti Market Security &bull; Please do not reply to this email.</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    console.error('[passwordReset] Failed to send email:', err.message);
    return false;
  }
}

async function requestPasswordReset({ email, clientType, origin, ipAddress, userAgent }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    const err = new Error('Email is required');
    err.statusCode = 400;
    throw err;
  }

  // Lookup user (anti-enumeration: always respond with same message)
  const user = await usersRepository.findByEmail(normalizedEmail);
  const genericResponse = {
    success: true,
    message: 'If that email address is registered, password reset instructions have been sent.',
  };

  if (!user || user.status !== 'active') {
    return genericResponse;
  }

  // Generate 256-bit cryptographically secure token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

  await passwordResetsRepo.createPasswordReset({
    userId: user.id,
    tokenHash,
    expiresAt,
    ipAddress,
    userAgent,
  });

  // Determine web portal destination URL
  let portalBase = 'http://localhost:8000'; // Default buyer/seller web
  if (clientType === 'admin' || user.role === 'ADMIN') {
    portalBase = process.env.ADMIN_WEB_URL || 'http://localhost:5173';
  } else if (origin && (origin.includes('5173') || origin.includes('admin'))) {
    portalBase = origin;
  } else if (process.env.WEB_URL) {
    portalBase = process.env.WEB_URL;
  }

  const resetLink = `${portalBase.replace(/\/+$/, '')}/reset-password?token=${rawToken}`;
  await sendResetEmail({
    email: user.email,
    name: user.name,
    resetLink,
  });

  return genericResponse;
}

async function verifyResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { valid: false, message: 'Invalid or missing reset token.' };
  }

  const tokenHash = hashToken(rawToken);
  const record = await passwordResetsRepo.findValidReset(tokenHash);
  if (!record) {
    return { valid: false, message: 'This password reset link is invalid or has expired.' };
  }

  return {
    valid: true,
    email: maskEmail(record.email),
    role: record.role,
  };
}

async function resetPassword({ token, newPassword, confirmPassword }) {
  if (!token || typeof token !== 'string') {
    const err = new Error('Reset token is required');
    err.statusCode = 400;
    throw err;
  }
  if (!newPassword || newPassword.length < 8) {
    const err = new Error('Password must be at least 8 characters long');
    err.statusCode = 400;
    throw err;
  }
  if (newPassword !== confirmPassword) {
    const err = new Error('Passwords do not match');
    err.statusCode = 400;
    throw err;
  }

  const tokenHash = hashToken(token);
  const record = await passwordResetsRepo.findValidReset(tokenHash);
  if (!record) {
    const err = new Error('This password reset link is invalid or has expired');
    err.statusCode = 400;
    throw err;
  }

  // Hash new password and update user in database
  const passwordHash = await hashPassword(newPassword);
  await usersRepository.updatePassword({ id: record.user_id, hash: passwordHash });

  // Mark token as consumed
  await passwordResetsRepo.markUsed(record.id);

  // Invalidate all active sessions & refresh tokens
  await refreshTokensRepo.revokeAllForUser(record.user_id);

  return {
    success: true,
    message: 'Password has been reset successfully. Please sign in with your new password.',
  };
}

module.exports = {
  requestPasswordReset,
  verifyResetToken,
  resetPassword,
};
