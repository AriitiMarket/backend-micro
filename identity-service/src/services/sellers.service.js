// Seller identity business logic — used by Commerce Service via internal endpoints.
//
// A seller grant writes a user_roles membership row (one account can now also be
// a delivery provider); only the PRIMARY role is promoted, and only for a plain
// buyer account. The seller_status column is kept in step because the admin
// pipeline and the frontend's suspension gate still read it.
const usersRepository = require('../repositories/users.repository');
const userRolesRepo = require('../repositories/user-roles.repository');
const { withTransaction } = require('../config/transaction');
const { hashPassword } = require('../utils/password');
const { toUser } = require('../models/User');
const { ROLES, MEMBERSHIP_STATUSES, MEMBERSHIP_SOURCES, normalizeRole } = require('../models/Role');

// seller_status (legacy column) -> membership status.
const MEMBERSHIP_STATUS_BY_SELLER_STATUS = Object.freeze({
  ACTIVE: MEMBERSHIP_STATUSES.ACTIVE,
  APPROVED: MEMBERSHIP_STATUSES.ACTIVE,
  APPROVED_SELLER: MEMBERSHIP_STATUSES.ACTIVE,
  PENDING: MEMBERSHIP_STATUSES.PENDING,
  PENDING_REVIEW: MEMBERSHIP_STATUSES.PENDING,
  SUSPENDED: MEMBERSHIP_STATUSES.SUSPENDED,
  REJECTED: MEMBERSHIP_STATUSES.REJECTED,
});

async function requireUser(userId) {
  const user = await usersRepository.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  return user;
}

/**
 * Write the SELLER membership status. Falls back to an insert when no row exists
 * yet, so an account that predates the membership table can never be left with a
 * seller_status that no membership reflects.
 */
async function setSellerMembershipStatus(userId, status, client) {
  const updated = await userRolesRepo.setStatus({ userId, role: ROLES.SELLER, status, client });
  if (updated) return updated;
  return userRolesRepo.upsert({
    userId,
    role: ROLES.SELLER,
    status,
    source: MEMBERSHIP_SOURCES.SELLER_APPLICATION,
    client,
  });
}

async function createSeller(payload) {
  const existing = await usersRepository.findByEmail(payload.email);
  if (existing) {
    const err = new Error('Shop Already Exists');
    err.statusCode = 400;
    throw err;
  }
  const passwordHash = await hashPassword(payload.password);
  const seller = await usersRepository.create({
    name: payload.name,
    email: payload.email,
    passwordHash: passwordHash,
    role: 'SELLER',
  });
  return { user: toUser(seller, { id: seller.id }) };
}

async function linkShopId(payload) {
  // Accept both spellings: Commerce used to send `{ ownerId }` while this read
  // `userId`, so the link silently never happened.
  const userId = payload.userId || payload.ownerId;
  if (!userId) {
    const err = new Error('userId is required');
    err.statusCode = 400;
    throw err;
  }
  await usersRepository.setShopId({ id: userId, shopId: payload.shopId });
  return { success: true };
}

async function findUserById(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  return { user: user };
}

async function grantSellerRole(payload) {
  const user = await requireUser(payload.userId);

  // An admin is never demoted by a seller grant.
  if (user.role === ROLES.ADMIN) {
    return { user, granted: false, reason: 'Account already has ADMIN role' };
  }

  const alreadyActive = (user.capabilities || []).includes(ROLES.SELLER);

  // The membership grant and the primary-role promotion are one logical change
  // and run in one transaction: a crash between them would leave an ACTIVE
  // membership on an account whose primary role was never promoted (or the
  // reverse), so the token and the membership table would disagree.
  const updated = await withTransaction(async (client) => {
    await userRolesRepo.upsert({
      userId: user.id,
      role: ROLES.SELLER,
      status: MEMBERSHIP_STATUSES.ACTIVE,
      source: MEMBERSHIP_SOURCES.SELLER_APPLICATION,
      // Approval is the terminal state of onboarding — an approved seller has
      // necessarily finished the application wizard.
      onboardingCompleted: true,
      client,
    });

    // Promote the PRIMARY role only for a plain buyer account, so a provider who
    // later becomes a seller keeps PROVIDER as primary and both stay live.
    if (normalizeRole(user.role) === ROLES.BUYER) {
      await usersRepository.setRole(user.id, ROLES.SELLER, { client });
    }

    return usersRepository.findById(user.id, { client });
  });

  return {
    user: updated,
    granted: !alreadyActive,
    reason: alreadyActive ? 'Account already holds the SELLER membership' : undefined,
  };
}

/**
 * Mark the seller onboarding wizard as finished.
 *
 * Relayed by Commerce when the applicant submits the full store application.
 * Idempotent, and it never touches the membership STATUS — a submitted
 * application is still PENDING (under review), and being `onboarding_completed`
 * is exactly what keeps the abandoned-application sweep from reclaiming it.
 *
 * A legacy buyer who applies through the single-account form has no membership
 * row yet (Commerce grants it on approval), so a missing row is a no-op rather
 * than an error.
 */
async function completeOnboarding(payload) {
  await requireUser(payload.userId);
  const membership = await userRolesRepo.completeOnboarding({
    userId: payload.userId,
    role: ROLES.SELLER,
  });
  return { membership };
}

/**
 * PHASE 3: Suspend a seller account.
 * Called by Commerce Service when admin suspends a seller.
 * Suspends ONLY the seller membership — any other actor the account holds
 * (e.g. provider) keeps working.
 */
async function suspendSeller(payload) {
  const user = await requireUser(payload.userId);
  if (!(user.capabilities || []).includes(ROLES.SELLER)) {
    const err = new Error('User is not a seller');
    err.statusCode = 400;
    throw err;
  }
  // Membership status and the legacy seller_status column must move together;
  // running them outside a transaction let them drift apart on any failure.
  const updated = await withTransaction(async (client) => {
    await setSellerMembershipStatus(user.id, MEMBERSHIP_STATUSES.SUSPENDED, client);
    return usersRepository.setSellerStatus({ id: user.id, status: 'SUSPENDED', client });
  });
  return { user: updated, message: 'Seller suspended' };
}

/**
 * PHASE 3: Reactivate a suspended seller.
 * Called by Commerce Service when admin reactivates a seller.
 */
async function reactivateSeller(payload) {
  const user = await requireUser(payload.userId);
  // Reactivation must work for a suspended seller whose capability is gone, so
  // this checks the membership row rather than the capability list.
  const memberships = await userRolesRepo.listForUser(user.id);
  const hasSellerMembership = memberships.some((m) => m.role === ROLES.SELLER);
  if (!hasSellerMembership) {
    const err = new Error('User is not a seller');
    err.statusCode = 400;
    throw err;
  }
  const updated = await withTransaction(async (client) => {
    await setSellerMembershipStatus(user.id, MEMBERSHIP_STATUSES.ACTIVE, client);
    return usersRepository.setSellerStatus({ id: user.id, status: 'ACTIVE', client });
  });
  return { user: updated, message: 'Seller reactivated' };
}

async function getSellerStatus(payload) {
  const user = await requireUser(payload.userId);
  const capabilities = user.capabilities || [];
  return {
    userId: user.id,
    role: user.role,
    roles: user.roles || [],
    capabilities,
    sellerStatus: user.sellerStatus,  // No longer falls back to ACTIVE, uses actual value
    isSuspended: user.sellerStatus === 'SUSPENDED',
    isActive: capabilities.includes(ROLES.SELLER),
  };
}

/**
 * Set seller status to APPROVED, PENDING, REJECTED, SUSPENDED, or ACTIVE.
 * Called by Commerce Service when approving/rejecting seller applications.
 * Writes BOTH the membership status and the legacy seller_status column.
 */
async function setSellerStatus(payload) {
  await requireUser(payload.userId);
  const key = String(payload.status || '').toUpperCase();
  const membershipStatus = MEMBERSHIP_STATUS_BY_SELLER_STATUS[key] || MEMBERSHIP_STATUSES.PENDING;
  // Both writes describe the same status change; keep them atomic.
  const updated = await withTransaction(async (client) => {
    await setSellerMembershipStatus(payload.userId, membershipStatus, client);
    return usersRepository.setSellerStatus({ id: payload.userId, status: payload.status, client });
  });
  return { user: updated };
}

module.exports = {
  createSeller,
  linkShopId,
  findUserById,
  grantSellerRole,
  completeOnboarding,
  suspendSeller,
  reactivateSeller,
  getSellerStatus,
  setSellerStatus,
};