// Auth request validators for Identity Service.
const { isValidCodeChallenge } = require('../utils/jwt');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;

function validationError(res, errors) {
  return res.status(400).json({ success: false, message: 'Validation failed', errors });
}

// PKCE parameters are mandatory on every authorization request (OAuth 2.1).
const validateAuthorize = (req, res, next) => {
  const errors = [];
  const method = req.body.code_challenge_method || req.query.code_challenge_method || 'S256';
  const challenge = req.body.code_challenge || req.query.code_challenge;
  if (!challenge) errors.push('code_challenge is required (PKCE)');
  else if (!isValidCodeChallenge(challenge, method)) {
    errors.push('code_challenge must be a 43-128 char base64url string (S256)');
  }
  if (method && method !== 'S256') errors.push("code_challenge_method must be 'S256'");
  if (errors.length) return validationError(res, errors);
  next();
};

const validateRegister = (req, res, next) => {
  const errors = [];
  if (req.body.email) req.body.email = String(req.body.email).trim();
  if (!req.body.name || req.body.name.trim().length < 2) errors.push('Name is required (min 2 chars)');
  if (!req.body.email || !EMAIL_RE.test(req.body.email)) errors.push('Valid email is required');
  if (!req.body.password || req.body.password.length < 8) errors.push('Password is required (min 8 chars)');
  if (errors.length) return validationError(res, errors);
  next();
};

const validateLogin = (req, res, next) => {
  const errors = [];
  if (req.body.email) req.body.email = String(req.body.email).trim();
  if (!req.body.email || (!EMAIL_RE.test(req.body.email) && !PHONE_RE.test(req.body.email))) errors.push('Enter a valid email address or phone number');
  if (!req.body.password) errors.push('Password is required');
  if (errors.length) return validationError(res, errors);
  next();
};

const validateUpdateProfile = (req, res, next) => {
  const errors = [];
  if (req.body.email && !EMAIL_RE.test(req.body.email)) errors.push('Valid email is required');
  if (req.body.name && req.body.name.trim().length < 2) errors.push('Name must be at least 2 characters');
  if (errors.length) return validationError(res, errors);
  next();
};

const validateUpdatePassword = (req, res, next) => {
  const errors = [];
  if (!req.body.oldPassword) errors.push('Old password is required');
  if (!req.body.newPassword || req.body.newPassword.length < 8) errors.push('New password is required (min 8 chars)');
  if (errors.length) return validationError(res, errors);
  next();
};

const validateUpdateAddress = (req, res, next) => {
  const errors = [];
  if (!req.body.country) errors.push('Country is required');
  if (!req.body.city) errors.push('City is required');
  if (!req.body.address1) errors.push('Address line 1 is required');
  if (!req.body.addressType) errors.push('Address type is required');
  if (errors.length) return validationError(res, errors);
  next();
};

const validateRoleRegistration = (req, res, next) => {
  const errors = [];
  if (req.body.email) req.body.email = String(req.body.email).trim();
  if (!req.body.name || req.body.name.trim().length < 2) errors.push('Name is required (min 2 chars)');
  if (!req.body.email || !EMAIL_RE.test(req.body.email)) errors.push('Valid email is required');
  if (!req.body.password || req.body.password.length < 8) errors.push('Password is required (min 8 chars)');
  
  const validRoles = ['BUYER', 'SELLER', 'PROVIDER'];
  const requestedRole = req.params.role || req.body.registrationType || req.body.role;
  if (!requestedRole || !validRoles.includes(requestedRole.toUpperCase())) {
    errors.push(`registrationType must be one of: ${validRoles.join(', ')}`);
  }
  
  if (errors.length) return validationError(res, errors);
  next();
};

module.exports = {
  validateAuthorize,
  validateRegister,
  validateLogin,
  validateUpdateProfile,
  validateUpdatePassword,
  validateUpdateAddress,
  validateRoleRegistration,
};
