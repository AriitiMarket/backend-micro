// Role constants for the Identity Service.
//
// MODEL: one account, many actor memberships.
//
// A user row carries ONE `role` — that is the account's PRIMARY role, and for
// ADMIN it is the only place the console role lives. Actor roles (SELLER,
// PROVIDER, AGENT) are held in the `user_roles` table instead, so one account
// can be a seller AND a delivery provider without either grant overwriting the
// other (previously `UPDATE users SET role = ...` made them mutually exclusive).
//
// CANONICAL platform actors: ADMIN, BUYER, SELLER, DELIVERY_PROVIDER (spelled
// PROVIDER in the identity vocabulary), AGENT (delivery rider/agent).
//
// PROVIDER is never self-assigned: the Delivery Service grants it over
// /internal/providers/grant-role once an admin approves the user's provider
// application, mirroring how Commerce grants SELLER.
//
// Legacy spelling: the buyer role used to be stored as `CUSTOMER`. Rows and
// tokens minted before the normalization still carry it, so every read path
// funnels through `normalizeRole()` — never compare raw role strings.
const ROLES = Object.freeze({
  BUYER: 'BUYER',
  SELLER: 'SELLER',
  PROVIDER: 'PROVIDER',
  AGENT: 'AGENT',
  ADMIN: 'ADMIN',
});

// Read-only map of pre-normalization spellings to their canonical value.
const LEGACY_ROLE_ALIASES = Object.freeze({
  CUSTOMER: 'BUYER',
  SUPER_ADMIN: 'ADMIN',
  OPERATIONS_ADMIN: 'ADMIN',
  OPERATIONAL_ADMIN: 'ADMIN',
  OPS_ADMIN: 'ADMIN',
  OPSADMIN: 'ADMIN',
  OS_ADMIN: 'ADMIN',
  OSADMIN: 'ADMIN',
  OPERATIONS: 'ADMIN',
});

/**
 * Canonicalize a role string. Unknown values are upper-cased and returned
 * unchanged so callers can still surface them (e.g. `INVALID_ROLE`).
 */
function normalizeRole(role) {
  const key = String(role || '').trim().toUpperCase();
  return LEGACY_ROLE_ALIASES[key] || key;
}

// Roles that must be held as a user_roles membership row. BUYER (buyer) is
// implicit for every account and ADMIN comes from the primary role, so neither
// needs a row.
const ACTOR_ROLES = Object.freeze(['SELLER', 'PROVIDER', 'AGENT']);

// Lifecycle of a membership. Only ACTIVE grants the capability — PENDING is an
// application under review, SUSPENDED/REJECTED keep the history but deny access.
const MEMBERSHIP_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REJECTED: 'REJECTED',
});

// Who granted the membership — kept for auditability.
const MEMBERSHIP_SOURCES = Object.freeze({
  SELLER_APPLICATION: 'SELLER_APPLICATION',
  PROVIDER_APPLICATION: 'PROVIDER_APPLICATION',
  ADMIN: 'ADMIN',
  MIGRATION: 'MIGRATION',
});

module.exports = {
  ROLES,
  LEGACY_ROLE_ALIASES,
  normalizeRole,
  ACTOR_ROLES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_SOURCES,
};
