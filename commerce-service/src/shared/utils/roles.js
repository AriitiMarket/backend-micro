// Canonical actor-role vocabulary (read-side helpers for Commerce).
//
// BUYER / SELLER / PROVIDER / AGENT / ADMIN are the only platform roles;
// `CUSTOMER` is a legacy spelling of BUYER that may still appear on old rows and
// on tokens minted before the rename. Everything that branches on a role goes
// through here so a legacy value can never take a different branch again.
const LEGACY_ROLE_ALIASES = {
  CUSTOMER: 'BUYER',
  PARTNER: 'PROVIDER',
  SUPER_ADMIN: 'ADMIN',
  OPERATIONS_ADMIN: 'ADMIN',
  OPERATIONAL_ADMIN: 'ADMIN',
  OPS_ADMIN: 'ADMIN',
  OPSADMIN: 'ADMIN',
  OS_ADMIN: 'ADMIN',
  OSADMIN: 'ADMIN',
  OPERATIONS: 'ADMIN',
};

function normalizeRole(role) {
  if (!role) return null;
  const upper = String(role).toUpperCase();
  return LEGACY_ROLE_ALIASES[upper] || upper;
}

function actorRoles(actor) {
  const values = actor && typeof actor === 'object'
    ? [actor.role, ...(Array.isArray(actor.capabilities) ? actor.capabilities : [])]
    : [actor];
  return values.map(normalizeRole).filter(Boolean);
}

const hasRole = (actor, ...roles) => {
  const held = actorRoles(actor);
  return roles.some((role) => held.includes(normalizeRole(role)));
};
const isBuyer = (actor) => hasRole(actor, 'BUYER');
const isSeller = (actor) => hasRole(actor, 'SELLER');
const isAdmin = (actor) => hasRole(actor, 'ADMIN');
const isProvider = (actor) => hasRole(actor, 'PROVIDER');

module.exports = { LEGACY_ROLE_ALIASES, normalizeRole, actorRoles, hasRole, isBuyer, isSeller, isAdmin, isProvider };
