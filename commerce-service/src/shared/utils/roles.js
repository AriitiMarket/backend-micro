// Canonical actor-role vocabulary (read-side helpers for Commerce).
//
// BUYER / SELLER / PROVIDER / AGENT / ADMIN are the only platform roles;
// `CUSTOMER` is a legacy spelling of BUYER that may still appear on old rows and
// on tokens minted before the rename. Everything that branches on a role goes
// through here so a legacy value can never take a different branch again.
const LEGACY_ROLE_ALIASES = { CUSTOMER: 'BUYER', PARTNER: 'PROVIDER' };

function normalizeRole(role) {
  if (!role) return null;
  const upper = String(role).toUpperCase();
  return LEGACY_ROLE_ALIASES[upper] || upper;
}

const isBuyer = (role) => normalizeRole(role) === 'BUYER';
const isSeller = (role) => normalizeRole(role) === 'SELLER';
const isAdmin = (role) => normalizeRole(role) === 'ADMIN';
const isProvider = (role) => normalizeRole(role) === 'PROVIDER';

module.exports = { LEGACY_ROLE_ALIASES, normalizeRole, isBuyer, isSeller, isAdmin, isProvider };
