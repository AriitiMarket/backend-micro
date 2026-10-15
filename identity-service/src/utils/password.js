// Password hashing helpers using bcryptjs.
//
// Password strength rules:
//   * minimum 8 characters
//   * at least one uppercase letter
//   * at least one lowercase letter
//   * at least one digit
//   * at least one special character
const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 8;
const UPPER_RE = /[A-Z]/;
const LOWER_RE = /[a-z]/;
const DIGIT_RE = /[0-9]/;
const SPECIAL_RE = /[^A-Za-z0-9]/;

function validatePasswordStrength(plain) {
  const errors = [];
  if (!plain || typeof plain !== 'string') {
    errors.push('Password is required');
    return errors;
  }
  if (plain.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!UPPER_RE.test(plain)) errors.push('Password must contain an uppercase letter');
  if (!LOWER_RE.test(plain)) errors.push('Password must contain a lowercase letter');
  if (!DIGIT_RE.test(plain)) errors.push('Password must contain a digit');
  if (!SPECIAL_RE.test(plain)) errors.push('Password must contain a special character');
  return errors;
}

async function hashPassword(plain) {
  const errors = validatePasswordStrength(plain);
  if (errors.length > 0) {
    const err = new Error(errors.join(', '));
    err.statusCode = 400;
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, comparePassword, validatePasswordStrength };