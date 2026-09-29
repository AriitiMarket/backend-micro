const sellerApplicantService = require('../services/sellerApplications.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, ACTIONS, LEVELS, getAdminFromReq } = require('../../../shared/utils/audit-client');

function currentUser(req) {
  return (req.user && req.user.id) || req.headers['x-user-id'] || null;
}
function currentRole(req) {
  return (req.user && req.user.role) || req.headers['x-user-role'] || null;
}

async function saveApplication(req, res, next) {
  try {
    const ownerId = currentUser(req);
    const app = await sellerApplicantService.saveApplication(ownerId, req.body || {});
    return created(res, { application: app }, 'Seller application saved');
  } catch (err) { return next(err); }
}

async function getMyApplication(req, res, next) {
  try {
    const ownerId = currentUser(req);
    const app = await sellerApplicantService.getMyApplication(ownerId);
    return ok(res, { application: app || null });
  } catch (err) { return next(err); }
}

/** Owner: throw away an abandoned DRAFT (see service for the guard rails). */
async function discardMyApplication(req, res, next) {
  try {
    const ownerId = currentUser(req);
    const result = await sellerApplicantService.discardDraft(ownerId);
    return ok(res, { discarded: result }, 'Draft discarded');
  } catch (err) { return next(err); }
}

async function listApplications(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only', errors: [] });
    }
    const query = req.query || {};
    const result = await sellerApplicantService.listApplications(query.status, query.page, query.size || query.limit, query.search);
    return ok(res, result);
  } catch (err) { return next(err); }
}

async function getApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only', errors: [] });
    }
    const app = await sellerApplicantService.getApplication(req.params.id);
    return ok(res, { application: app });
  } catch (err) { return next(err); }
}

async function approveApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only', errors: [] });
    }
    const locationId = (req.body && req.body.locationId) || null;
    const sectorId = (req.body && req.body.sectorId) || null;
    const result = await sellerApplicantService.approve(req.params.id, currentUser(req), locationId, sectorId);
    sendAudit({
      action: ACTIONS.SELLER_APPLICATION_APPROVED,
      ...getAdminFromReq(req),
      module: 'commerce',
      targetEntity: 'seller_application',
      targetId: req.params.id,
    });
    return ok(res, result, 'Seller application approved');
  } catch (err) { return next(err); }
}

async function rejectApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only', errors: [] });
    }
    const reason = (req.body && req.body.reason) || null;
    const app = await sellerApplicantService.reject(req.params.id, currentUser(req), reason);
    sendAudit({
      action: ACTIONS.SELLER_APPLICATION_REJECTED,
      level: LEVELS.WARNING,
      ...getAdminFromReq(req),
      module: 'commerce',
      targetEntity: 'seller_application',
      targetId: req.params.id,
      reason,
    });
    return ok(res, { application: app }, 'Seller application rejected');
  } catch (err) { return next(err); }
}

async function requestInformation(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only', errors: [] });
    }
    const reason = (req.body && req.body.reason) || null;
    const app = await sellerApplicantService.requestInformation(req.params.id, currentUser(req), reason);
    return ok(res, { application: app }, 'Additional information requested');
  } catch (err) { return next(err); }
}

async function suspendApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only', errors: [] });
    }
    const suspended = (req.body && req.body.suspended) !== false;
    const app = await sellerApplicantService.setSuspended(req.params.id, suspended, currentUser(req));
    sendAudit({
      action: ACTIONS.SELLER_APPLICATION_SUSPENDED,
      level: LEVELS.WARNING,
      ...getAdminFromReq(req),
      module: 'commerce',
      targetEntity: 'seller_application',
      targetId: req.params.id,
      newValue: { suspended },
    });
    return ok(res, { application: app });
  } catch (err) { return next(err); }
}

module.exports = {
  saveApplication,
  getMyApplication,
  discardMyApplication,
  listApplications,
  getApplication,
  approveApplication,
  rejectApplication,
  requestInformation,
  suspendApplication,
};
