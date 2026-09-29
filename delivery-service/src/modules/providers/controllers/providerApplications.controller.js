// Provider application controller — the applicant-facing surface plus the admin
// review queue. Every applicant action is scoped to the authenticated caller
// (req.user.id); the applicant never supplies an identity in the body.
const svc = require('../services/providerApplications.service');
const providersSvc = require('../services/providers.service');
const { ok, created, fail } = require('../../../shared/utils/response');
const { getAdminFromReq } = require('../../../shared/utils/audit-client');

function serialize(provider) {
  if (!provider) return null;
  const doc = typeof provider.toObject === 'function' ? provider.toObject() : provider;
  return {
    id: doc._id,
    status: doc.status,
    name: doc.name,
    phone: doc.phone,
    email: doc.email || null,
    providerType: doc.providerType,
    vehicleType: doc.vehicleType,
    plateNumber: doc.plateNumber || '',
    application: doc.metadata?.application || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** POST /provider-application — submit or amend the caller's own application. */
async function submitApplication(req, res, next) {
  try {
    const { provider, created: isNew } = await svc.applyForProvider(req.user.id, req.body);
    svc.auditApplicationSubmitted(provider, req.user);
    const body = { application: serialize(provider) };
    if (isNew) return created(res, body, 'Application submitted');
    return ok(res, body, 'Application updated');
  } catch (err) { return next(err); }
}

/** GET /provider-application/me — status of the caller's own application. */
async function getMyApplication(req, res, next) {
  try {
    const provider = await svc.getMyApplication(req.user.id);
    // No application is a normal answer, not an error: the status page renders
    // the "not applied yet" state from it.
    return ok(res, { application: serialize(provider) }, provider ? '' : 'No application found');
  } catch (err) { return next(err); }
}

/** DELETE /provider-application/me — withdraw an application still awaiting review. */
async function withdrawMyApplication(req, res, next) {
  try {
    const result = await svc.withdrawMyApplication(req.user.id);
    return ok(res, result, 'Application withdrawn');
  } catch (err) { return next(err); }
}

/** GET /provider-application — ADMIN review queue (all statuses, filterable). */
async function listApplications(req, res, next) {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [providers, total] = await Promise.all([
      providersSvc.getProviders(filter, { skip, limit: safeLimit, sort: { createdAt: -1 } }),
      providersSvc.countProviders(filter),
    ]);
    return ok(res, {
      applications: providers.map(serialize),
      count: providers.length,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { return next(err); }
}

/** GET /provider-application/:id — ADMIN single application. */
async function getApplication(req, res, next) {
  try {
    const provider = await providersSvc.getProvider(req.params.id);
    return ok(res, { application: serialize(provider) });
  } catch (err) { return next(err); }
}

/**
 * POST /provider-application/:id/approve — ADMIN decision.
 *
 * Approval is two steps that must not silently diverge: flip the provider to a
 * usable status, then provision the account role in Identity. If provisioning
 * fails the caller is told, because a "provider" whose account was never granted
 * the role cannot enter the provider workspace.
 */
async function approveApplication(req, res, next) {
  try {
    // Provision first: if the account cannot be granted the PROVIDER role there
    // is no point approving, because the applicant would land in the provider
    // workspace with no access. Nothing has been mutated when this fails.
    const provider = await providersSvc.getProvider(req.params.id);
    const provisioning = await providersSvc.provisionProviderAccount(provider);
    if (provisioning.blocking) {
      return fail(res, 502, `Account provisioning failed: ${provisioning.reason || 'Identity Service unavailable'}`);
    }
    const approved = await providersSvc.approveProvider(req.params.id, getAdminFromReq(req));
    return ok(res, { application: serialize(approved), provisioning }, 'Application approved');
  } catch (err) { return next(err); }
}

/** POST /provider-application/:id/reject — ADMIN decision with a reason. */
async function rejectApplication(req, res, next) {
  try {
    const provider = await providersSvc.rejectProvider(req.params.id, req.body.reason, getAdminFromReq(req));
    return ok(res, { application: serialize(provider) }, 'Application rejected');
  } catch (err) { return next(err); }
}

module.exports = {
  submitApplication,
  getMyApplication,
  withdrawMyApplication,
  listApplications,
  getApplication,
  approveApplication,
  rejectApplication,
};
