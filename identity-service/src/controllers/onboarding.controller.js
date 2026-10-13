// Onboarding lifecycle controller — internal only (Commerce / Delivery / ops).
//
//   POST /internal/onboarding/:role/complete  -> mark a wizard as finished
//   POST /internal/onboarding/cleanup         -> run the abandoned sweep now
//
// Neither is reachable by a browser: both sit behind internalOnly (cluster
// credential) and are only ever called service-to-service.
const sellersService = require('../services/sellers.service');
const providersService = require('../services/providers.service');
const onboardingService = require('../services/onboarding.service');
const { ok } = require('../utils/response');

// Mark the role's onboarding wizard complete. Idempotent; safe to call on every
// application submission. A role with no membership row is a no-op (the
// single-account model lets a plain buyer apply without ever registering as an
// actor).
async function completeOnboarding(req, res, next) {
  try {
    const role = String(req.params.role || req.body.role || '').toUpperCase();
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required', errors: [] });
    }

    let result;
    if (role === 'SELLER') {
      result = await sellersService.completeOnboarding({ userId });
    } else if (role === 'PROVIDER') {
      result = await providersService.completeOnboarding({ userId });
    } else {
      return res.status(400).json({ success: false, message: 'role must be SELLER or PROVIDER', errors: [] });
    }

    return ok(res, { role, userId, completed: Boolean(result.membership), ...result }, 'Onboarding marked complete');
  } catch (err) {
    return next(err);
  }
}

// Run the abandoned-application sweep on demand. The background job calls the
// same service; this route exists for ops to trigger it (and for a one-shot run
// during a deploy).
async function runCleanup(req, res, next) {
  try {
    const olderThanDays = req.body.olderThanDays !== undefined
      ? parseInt(req.body.olderThanDays, 10)
      : undefined;
    const summary = await onboardingService.runAbandonedCleanup({
      olderThanDays: Number.isFinite(olderThanDays) ? olderThanDays : undefined,
      archiveAccounts: req.body.archiveAccounts,
      limit: req.body.limit,
    });
    return ok(res, summary, 'Abandoned onboarding cleanup complete');
  } catch (err) {
    return next(err);
  }
}

module.exports = { completeOnboarding, runCleanup };
