// Capability policy — the single place where roles receive capabilities.
//
// Business logic (services, controllers, middleware) only ever asks
// "does this actor hold capability X?" and never compares role names, so new
// roles can be introduced later without touching delivery code:
//
//   * `delivery.view`    — read deliveries, requests and tracking history;
//   * `delivery.manage`  — create/validate deliveries and change operational
//                          state (current MVP: Platform Admin only);
//   * `delivery.override`— bypass guarded operational boundaries such as the
//                          cancellation cutoff (current MVP: Platform Admin).
//
// The API Gateway enforces the same capability names at the edge
// (`delivery.view` / `delivery.manage`); this module is the service-side,
// defense-in-depth copy. When Community Coordinator / Delivery Agent roles are
// introduced, they are added to the lists below — nothing else changes.
//
// Roles are spelled with the canonical platform vocabulary
// BUYER / SELLER / PROVIDER / AGENT / ADMIN — the same one Identity issues and
// the canonical authorize() middleware enforces.
const CAPABILITY_ROLES = {
  'delivery.view': ['ADMIN', 'SELLER', 'BUYER'],
  'delivery.manage': ['ADMIN'],
  'delivery.override': ['ADMIN'],
};

// Read-only map of pre-normalization spellings, so a token minted before the
// rename (or a legacy row) still answers instead of being locked out. Mirrors
// LEGACY_ROLE_ALIASES in the canonical authorize() middleware.
const LEGACY_ROLE_ALIASES = {
  CUSTOMER: 'BUYER',
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
  if (!role) return role;
  const upper = String(role).toUpperCase();
  return LEGACY_ROLE_ALIASES[upper] || upper;
}

function rolesFor(capability) {
  return CAPABILITY_ROLES[capability] || [];
}

function hasCapability(role, capability) {
  return Boolean(role) && rolesFor(capability).includes(normalizeRole(role));
}

module.exports = { CAPABILITY_ROLES, rolesFor, hasCapability };
