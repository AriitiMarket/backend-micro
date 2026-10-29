// Seller Applications Controller — manages seller onboarding lifecycle, application drafts, and admin approval workflows.
'use strict';

const sellerApplicantService = require('../services/sellerApplications.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, ACTIONS, LEVELS, getAdminFromReq } = require('../../../shared/utils/audit-client');

/**
 * Helper to extract current user ID from authenticated request or gateway headers.
 * 
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function currentUser(req) {
  return (req.user && req.user.id) || req.headers['x-user-id'] || null;
}

/**
 * Helper to extract current user role from authenticated request or gateway headers.
 * 
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function currentRole(req) {
  return (req.user && req.user.role) || req.headers['x-user-role'] || null;
}

/**
 * Standard forbidden response envelope for non-admin callers.
 * 
 * @param {import('express').Response} res
 */
function sendForbidden(res) {
  return res.status(403).json({
    success: false,
    code: 'FORBIDDEN',
    message: 'Admin only',
    errors: [],
  });
}

/**
 * Save or submit a seller onboarding application draft.
 * 
 * @param {import('express').Request} req - Express request with application payload
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function saveApplication(req, res, next) {
  try {
    const ownerId = currentUser(req);
    const app = await sellerApplicantService.saveApplication(ownerId, req.body || {});
    return created(res, { application: app }, 'Seller application saved');
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve the current authenticated seller's existing application and onboarding state.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getMyApplication(req, res, next) {
  try {
    const ownerId = currentUser(req);
    const app = await sellerApplicantService.getMyApplication(ownerId);
    return ok(res, { application: app || null });
  } catch (err) {
    return next(err);
  }
}

/**
 * Discard an abandoned DRAFT seller application.
 * Only drafts may be discarded to preserve audit timeline for submitted applications.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function discardMyApplication(req, res, next) {
  try {
    const ownerId = currentUser(req);
    const result = await sellerApplicantService.discardDraft(ownerId);
    return ok(res, { discarded: result }, 'Draft discarded');
  } catch (err) {
    return next(err);
  }
}

/**
 * Admin: list seller applications with optional status filtering, search, and pagination.
 * 
 * @param {import('express').Request} req - Express request with query params { status, page, size, limit, search }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listApplications(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return sendForbidden(res);
    }
    const query = req.query || {};
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const rawLimit = query.size || query.limit;
    const limit = Math.min(100, Math.max(1, parseInt(rawLimit, 10) || 10));
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const status = query.status ? String(query.status).trim() : undefined;

    const result = await sellerApplicantService.listApplications(status, page, limit, search);
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Admin: retrieve details of a specific seller application by ID.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return sendForbidden(res);
    }
    const app = await sellerApplicantService.getApplication(req.params.id);
    return ok(res, { application: app });
  } catch (err) {
    return next(err);
  }
}

/**
 * Admin: approve a seller application, activating the seller role and provisioning shop.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { locationId, sectorId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function approveApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return sendForbidden(res);
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Admin: reject a seller application with a specified reason.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { reason }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function rejectApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return sendForbidden(res);
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Admin: request additional clarification or documents from applicant.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { reason }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function requestInformation(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return sendForbidden(res);
    }
    const reason = (req.body && req.body.reason) || null;
    const app = await sellerApplicantService.requestInformation(req.params.id, currentUser(req), reason);
    return ok(res, { application: app }, 'Additional information requested');
  } catch (err) {
    return next(err);
  }
}

/**
 * Admin: toggle suspension status of a seller application.
 * 
 * @param {import('express').Request} req - Express request with params { id } and body { suspended }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function suspendApplication(req, res, next) {
  try {
    if (currentRole(req) !== 'ADMIN') {
      return sendForbidden(res);
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
  } catch (err) {
    return next(err);
  }
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

