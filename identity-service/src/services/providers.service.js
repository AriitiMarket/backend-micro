// Provider identity business logic — used by the Delivery Service via internal
// endpoints.
//
// Owning the role grant here (rather than letting the Delivery Service write to
// the users table) keeps Identity as the only writer of account roles, exactly
// how Commerce provisions SELLER through /internal/sellers/grant-role.
//
// Since one account can hold many actors, a grant writes a user_roles membership
// row and only *promotes* the primary role when the account has no actor role
// yet. It never overwrites an existing actor role.
const usersRepository = require('../repositories/users.repository');
const userRolesRepo = require('../repositories/user-roles.repository');
const { capabilitiesFor } = require('../models/User');
const { ROLES, MEMBERSHIP_STATUSES, MEMBERSHIP_SOURCES, normalizeRole } = require('../models/Role');

const PROVIDER_ROLE = ROLES.PROVIDER;

async function requireUser(userId) {
  const user = await usersRepository.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  return user;
}

async function grantProviderRole(payload) {
  const user = await requireUser(payload.userId);

  // Never demote a privileged account: an admin who is also a delivery provider
  // keeps ADMIN (their primary role), which already outranks PROVIDER.
  if (user.role === ROLES.ADMIN) {
    return { user, granted: false, reason: 'Account already has ADMIN role' };
  }

  const alreadyActive = (user.capabilities || []).includes(PROVIDER_ROLE);

  await userRolesRepo.upsert({
    userId: user.id,
    role: PROVIDER_ROLE,
    status: MEMBERSHIP_STATUSES.ACTIVE,
    source: MEMBERSHIP_SOURCES.PROVIDER_APPLICATION,
  });

  // Promote the PRIMARY role only for a plain buyer account, so a seller who
  // becomes a provider keeps SELLER as primary and both capabilities stay live.
  if (normalizeRole(user.role) === ROLES.BUYER) {
    await usersRepository.setRole(user.id, PROVIDER_ROLE);
  }

  const updated = await usersRepository.findById(user.id);
  return {
    user: updated,
    granted: !alreadyActive,
    reason: alreadyActive ? 'Account already holds the PROVIDER membership' : undefined,
  };
}

/** Suspend / reactivate the provider membership without touching other actors. */
async function setProviderStatus(payload) {
  const user = await requireUser(payload.userId);
  const membership = await userRolesRepo.setStatus({
    userId: user.id,
    role: PROVIDER_ROLE,
    status: payload.status,
  });
  if (!membership) {
    const err = new Error('Provider membership not found');
    err.statusCode = 404;
    throw err;
  }
  return { user: await usersRepository.findById(user.id), membership };
}

async function getProviderStatus(payload) {
  const user = await requireUser(payload.userId);
  return {
    userId: user.id,
    role: user.role,
    roles: user.roles || [],
    capabilities: user.capabilities || capabilitiesFor(user.role, []),
    isProvider: (user.capabilities || []).includes(PROVIDER_ROLE),
  };
}

module.exports = {
  grantProviderRole,
  setProviderStatus,
  getProviderStatus,
  PROVIDER_ROLE,
};

