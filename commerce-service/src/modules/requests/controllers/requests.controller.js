const requestsService = require('../services/requests.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq, ACTIONS } = require('../../../shared/utils/audit-client');

async function createRequest(req, res, next) { try { const request = await requestsService.create(req.body, req.user || {}); await sendAudit({ action: ACTIONS.REQUEST_CREATED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id }); return created(res, { request }, 'Request submitted'); } catch (err) { return next(err); } }
async function getMyRequests(req, res, next) { try { const requests = await requestsService.listMine(req.user.id, req.query); return ok(res, { requests, count: requests.length }); } catch (err) { return next(err); } }
async function getRequest(req, res, next) { try { const request = await requestsService.getForUser(req.params.id, req.user); await sendAudit({ action: ACTIONS.REQUEST_VIEWED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id }); return ok(res, { request }); } catch (err) { return next(err); } }
async function getMessages(req, res, next) { try { const messages = await requestsService.getMessages(req.params.id, req.user); return ok(res, { messages }); } catch (err) { return next(err); } }
async function cancelRequest(req, res, next) { try { const request = await requestsService.cancel(req.params.id, req.user); await sendAudit({ action: ACTIONS.REQUEST_CANCELLED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id }); return ok(res, { request }, 'Request cancelled'); } catch (err) { return next(err); } }
async function listRequests(req, res, next) { try { const page = await requestsService.listAll(req.query); return ok(res, page); } catch (err) { return next(err); } }
async function getRequestStats(req, res, next) { try { const stats = await requestsService.stats(); return ok(res, stats); } catch (err) { return next(err); } }
async function listShopRequests(req, res, next) { try { const requests = await requestsService.listForShop(req.params.shopId, req.user.id); return ok(res, { requests, count: requests.length }); } catch (err) { return next(err); } }
async function addMessage(req, res, next) { try { const message = await requestsService.addMessage(req.params.id, req.body, req.user); await sendAudit({ action: ACTIONS.REQUEST_MESSAGE_SENT, ...getAdminFromReq(req), targetEntity: 'request', targetId: req.params.id }); return created(res, { message }, 'Message sent'); } catch (err) { return next(err); } }
// The offer audit is raised inside the service, where "new offer" vs
// "replacement offer" (supersede), price change and quantity change are known.
async function makeOffer(req, res, next) { try { const request = await requestsService.makeOffer(req.params.id, req.body, req.user); return ok(res, { request }, 'Offer created'); } catch (err) { return next(err); } }
// Agreement audits (accepted / agreed / confirmed) are raised inside the
// service: it is the only place that knows whether BOTH sides confirmed.
async function acceptOffer(req, res, next) { try { const request = await requestsService.acceptOffer(req.params.id, req.user); return ok(res, { request }, 'Offer accepted'); } catch (err) { return next(err); } }
async function confirmAgreement(req, res, next) { try { const request = await requestsService.confirmAgreement(req.params.id, req.user, req.body?.note); return ok(res, { request }, 'Agreement confirmed'); } catch (err) { return next(err); } }
async function declineOffer(req, res, next) { try { const request = await requestsService.declineOffer(req.params.id, req.user); await sendAudit({ action: ACTIONS.REQUEST_OFFER_DECLINED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id }); return ok(res, { request }, 'Offer declined'); } catch (err) { return next(err); } }
async function acceptRequest(req, res, next) { try { const request = await requestsService.acceptRequest(req.params.id, req.user); await sendAudit({ action: ACTIONS.REQUEST_ACCEPTED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id }); return ok(res, { request }, 'Request accepted'); } catch (err) { return next(err); } }
// Audit raised inside the service (productId is known only after resolution).
async function attachOfferProduct(req, res, next) { try { const request = await requestsService.attachOfferProduct(req.params.id, req.body, req.user); return ok(res, { request }, 'Product attached to offer'); } catch (err) { return next(err); } }
async function convertToOrder(req, res, next) { try { const result = await requestsService.convertToOrder(req.params.id, req.body, req.user); await sendAudit({ action: ACTIONS.REQUEST_CONVERTED_TO_ORDER, ...getAdminFromReq(req), targetEntity: 'request', targetId: req.params.id, details: { orderId: result.order._id } }); return created(res, result, 'Request converted to order'); } catch (err) { return next(err); } }
async function declineRequest(req, res, next) { try { const request = await requestsService.decline(req.params.id, req.user); await sendAudit({ action: ACTIONS.REQUEST_DECLINED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id }); return ok(res, { request }, 'Request declined'); } catch (err) { return next(err); } }
async function closeRequest(req, res, next) { try { const request = await requestsService.adminClose(req.params.id, req.user, req.body?.reason); await sendAudit({ action: ACTIONS.REQUEST_ADMIN_INTERVENTION, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id, previousValue: null, newValue: { status: 'DECLINED' }, reason: req.body?.reason || 'closed by admin', level: 'WARNING' }); return ok(res, { request }, 'Request closed'); } catch (err) { return next(err); } }

// ── reporting ─────────────────────────────────────────────────────────────
async function reportRequest(req, res, next) { try { const request = await requestsService.report(req.params.id, req.body, req.user); return created(res, { request }, 'Report submitted'); } catch (err) { return next(err); } }
async function reviewReport(req, res, next) { try { const request = await requestsService.adminReviewReport(req.params.id, req.params.reportId, req.body, req.user); return ok(res, { request }, 'Report reviewed'); } catch (err) { return next(err); } }

// ── moderation ────────────────────────────────────────────────────────────
async function suspendRequest(req, res, next) { try { const request = await requestsService.adminSuspend(req.params.id, req.user, req.body?.reason); await sendAudit({ action: ACTIONS.REQUEST_SUSPENDED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id, reason: req.body?.reason || 'suspended', level: 'WARNING' }); return ok(res, { request }, 'Request suspended'); } catch (err) { return next(err); } }
async function restoreRequest(req, res, next) { try { const request = await requestsService.adminRestore(req.params.id, req.user, req.body?.reason); await sendAudit({ action: ACTIONS.REQUEST_RESTORED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id, reason: req.body?.reason || 'restored' }); return ok(res, { request }, 'Request restored'); } catch (err) { return next(err); } }
async function removeAttachment(req, res, next) { try { const request = await requestsService.adminRemoveAttachment(req.params.id, req.user, req.body?.url); await sendAudit({ action: ACTIONS.REQUEST_ATTACHMENT_REMOVED, ...getAdminFromReq(req), targetEntity: 'request', targetId: request._id, reason: 'removed by admin', level: 'WARNING' }); return ok(res, { request }, 'Attachment removed'); } catch (err) { return next(err); } }

// ── account restrictions ──────────────────────────────────────────────────
async function createRestriction(req, res, next) { try { const restriction = await requestsService.restrict(req.body, req.user); return created(res, { restriction }, 'Account restricted'); } catch (err) { return next(err); } }
async function listRestrictions(req, res, next) { try { const page = await requestsService.listRestrictions(req.query); return ok(res, page); } catch (err) { return next(err); } }
async function liftRestriction(req, res, next) { try { const restriction = await requestsService.liftRestriction(req.params.restrictionId, req.user, req.body?.reason); return ok(res, { restriction }, 'Restriction lifted'); } catch (err) { return next(err); } }

module.exports = {
  createRequest, getMyRequests, getRequest, getMessages, cancelRequest,
  listRequests, getRequestStats, listShopRequests, addMessage, makeOffer,
  acceptOffer, confirmAgreement, declineOffer, acceptRequest, attachOfferProduct,
  convertToOrder, declineRequest, closeRequest, reportRequest, reviewReport,
  suspendRequest, restoreRequest, removeAttachment,
  createRestriction, listRestrictions, liftRestriction,
};
