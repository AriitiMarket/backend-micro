// User entity model — Entity definition only, no business logic.
const USER_FIELDS = Object.freeze([
  'id',
  'name',
  'email',
  'phoneNumber',
  'role',
  'avatarPublicId',
  'avatarUrl',
  'addresses',
  'shopId',
  'status',
  'isVerified',
  'sellerStatus',
  'createdAt',
  'updatedAt',
]);

// Capabilities derived from the account's PRIMARY role + its actor memberships.
//
// The frontend route guards read `user.capabilities` (see
// frontend/src/app/routes/ProtectedRoute.jsx and ProviderGuard.jsx), and the
// services' authorize() gate reads them from the gateway header, so the list must
// be produced here — the one place every user payload is mapped.
//
// Rules:
//   * every account is a BUYER (implicit, no membership row needed);
//   * ADMIN comes from the primary role and is the only role that grants admin;
//   * an actor role (SELLER / PROVIDER / AGENT) is granted when its membership
//     row is ACTIVE — so one account can hold several at once;
//   * legacy fallback: an actor role with NO membership row yet still counts, but
//     only while it is the primary role. This keeps accounts granted before
//     `user_roles` existed working, while letting a row's status take over the
//     moment it exists (so a SUSPENDED membership really does deny access).
const { ACTOR_ROLES, MEMBERSHIP_STATUSES, normalizeRole } = require('./Role');

const ROLE_ADMIN = 'ADMIN';

function capabilitiesFor(role, memberships = []) {
  const primary = normalizeRole(role);
  // Every account is a buyer — the capability is implicit, so it needs no
  // membership row. `BUYER` is the one canonical spelling (route gates,
  // frontend guards and the gateway header all speak it); legacy tokens that
  // still carry `CUSTOMER` are canonicalized by authorize().
  //
  // ADMIN deliberately does NOT get it: buyer-scoped routes check ownership with
  // `role !== 'ADMIN'` and would let an admin read another account's orders —
  // and a `authorize('BUYER', { exact: true })` gate would accept the capability
  // and let an admin walk through a buyer-only endpoint.
  const capabilities = primary === ROLE_ADMIN ? [ROLE_ADMIN] : ['BUYER'];

  const statusByRole = new Map();
  for (const membership of Array.isArray(memberships) ? memberships : []) {
    if (!membership || !membership.role) continue;
    statusByRole.set(String(membership.role).toUpperCase(), String(membership.status || '').toUpperCase());
  }

  for (const actorRole of ACTOR_ROLES) {
    const membershipStatus = statusByRole.get(actorRole);
    if (membershipStatus) {
      if (membershipStatus === MEMBERSHIP_STATUSES.ACTIVE || membershipStatus === 'APPROVED') capabilities.push(actorRole);
    } else if (primary === actorRole) {
      capabilities.push(actorRole);
    }
  }

  return capabilities;
}

/** Actor roles an account currently holds (ACTIVE memberships only). */
function actorRolesFor(memberships = []) {
  return (Array.isArray(memberships) ? memberships : [])
    .filter((m) => {
      const s = String(m?.status || '').toUpperCase();
      return s === MEMBERSHIP_STATUSES.ACTIVE || s === 'APPROVED';
    })
    .map((m) => normalizeRole(m.role));
}

/**
 * Membership lifecycle per actor role — `{ SELLER: 'PENDING', PROVIDER: 'ACTIVE' }`.
 *
 * Signed into the access token (`role_statuses`) and relayed by the gateway as
 * `x-user-role-statuses`, so authorize() can answer a denial with
 * ROLE_NOT_APPROVED / ROLE_REJECTED instead of a bare 403. Only roles with a
 * membership row appear; an absent key means "never applied".
 */
function roleStatusesFor(memberships = []) {
  const statuses = {};
  for (const membership of Array.isArray(memberships) ? memberships : []) {
    if (!membership || !membership.role) continue;
    const role = normalizeRole(membership.role);
    if (!ACTOR_ROLES.includes(role)) continue;
    statuses[role] = String(membership.status || '').toUpperCase();
  }
  return statuses;
}

// Map a PostgreSQL row to a clean camelCase user object (without the password hash.
// `row.memberships` is optional: only the single-user profile reads attach it, so
// list endpoints stay one query.
function toUser(row) {
  if (!row) return null;
  const capabilities = capabilitiesFor(row.role, row.memberships);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phoneNumber: row.phone_number || null,
    // PRIMARY role: what the account is at home. Stable — switching the active
    // actor never changes it. Legacy `CUSTOMER` rows read back as `BUYER`.
    role: normalizeRole(row.role),
    // ACTIVE role: which of the account's roles it is acting as right now
    // (null = the primary one). Only ever set to a role the account holds.
    activeRole: normalizeRole(row.active_role || row.role),
    capabilities,
    roles: actorRolesFor(row.memberships),
    roleStatuses: roleStatusesFor(row.memberships),
    avatar: {
      public_id: row.avatar_public_id || null,
      url: row.avatar_url || null,
    },
    addresses: row.addresses || [],
    shopId: row.shop_id || null,
    status: row.status,
    isVerified: row.is_verified,
    sellerStatus: row.seller_status || 'INACTIVE',
    twoFactorEnabled: Boolean(row.two_factor_enabled),
    twoFactorType: row.two_factor_type || null,
    twoFactorDestination: row.two_factor_destination || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  USER_FIELDS,
  toUser,
  capabilitiesFor,
  actorRolesFor,
  roleStatusesFor,
  ROLE_CAPABILITIES: ACTOR_ROLES,
};
