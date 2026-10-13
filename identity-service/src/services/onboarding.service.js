// Onboarding lifecycle — abandoned application cleanup.
//
// A seller/provider account is created PENDING with `onboarding_completed = false`
// the moment someone registers through the seller/provider form (see
// auth.service.registerWithRole). If that person never finishes the wizard —
// never submits the store/vehicle details — the membership is dead weight: no
// review action will ever move it, it clutters the admin queue, and it pins the
// email address. This module reclaims those memberships after a configurable
// inactivity window (default 30 days).
//
// A SUBMITTED application is deliberately never selected: it has
// `onboarding_completed = true` and is legitimately waiting for a reviewer, which
// is a different PENDING. Only "registered, never submitted" is abandoned.
//
// The whole pass runs in one transaction so a failure halfway through cannot
// leave memberships deleted but (optionally) accounts not archived, or vice
// versa.
const usersRepository = require('../repositories/users.repository');
const userRolesRepo = require('../repositories/user-roles.repository');
const { withTransaction } = require('../config/transaction');
const env = require('../config/env');

/**
 * Run one cleanup pass.
 *
 * @param {object} [options]
 * @param {number} [options.olderThanDays] inactivity window (default from env)
 * @param {boolean} [options.archiveAccounts] also archive the now-empty accounts
 * @param {number} [options.limit] max memberships to reclaim in this pass
 * @param {object} [options.pool] pool override (tests)
 * @returns {Promise<{scanned:number, removed:number, archived:number, olderThanDays:number, removedMemberships:Array<object>}>}
 */
async function runAbandonedCleanup(options = {}) {
  const olderThanDays = Number.isFinite(options.olderThanDays)
    ? options.olderThanDays
    : env.onboardingAbandonAfterDays;
  const archiveAccounts = options.archiveAccounts !== undefined
    ? Boolean(options.archiveAccounts)
    : env.onboardingCleanupArchiveAccounts;
  const limit = Number.isFinite(options.limit) ? options.limit : env.onboardingCleanupBatchLimit;

  return withTransaction(async (client) => {
    const abandoned = await userRolesRepo.listAbandonedPending({ olderThanDays, limit, client });
    if (abandoned.length === 0) {
      return { scanned: 0, removed: 0, archived: 0, olderThanDays, removedMemberships: [] };
    }

    // 1) Reclaim the dead application memberships.
    const removed = await userRolesRepo.deleteMemberships(
      abandoned.map((membership) => ({ userId: membership.userId, role: membership.role })),
      { client }
    );

    // 2) Optionally archive the accounts those memberships belonged to — but only
    //    the ones that are now genuinely empty (no other membership, no shop,
    //    never verified). A real account is left completely untouched.
    let archived = 0;
    if (archiveAccounts) {
      const candidates = [...new Set(abandoned.map((membership) => String(membership.userId)))];
      const archivable = await usersRepository.findArchivableAccounts(candidates, { client });
      for (const id of archivable) {
        await usersRepository.setStatus(id, 'inactive', { client });
        archived += 1;
      }
    }

    return {
      scanned: abandoned.length,
      removed,
      archived,
      olderThanDays,
      removedMemberships: abandoned.map((membership) => ({
        userId: membership.userId,
        role: membership.role,
        onboardingStartedAt: membership.onboardingStartedAt,
        grantedAt: membership.grantedAt,
      })),
    };
  }, options.pool ? { pool: options.pool } : {});
}

module.exports = { runAbandonedCleanup };
