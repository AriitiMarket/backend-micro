const express = require('express');
const router = express.Router();
const controller = require('../controllers/requests.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');
const {
  validateCreateRequest,
  validateAddMessage,
  validateMakeOffer,
  validateConfirmAgreement,
  validateReportRequest,
  validateSuspendRequest,
  validateReviewReport,
  validateRestriction,
  validateListQuery,
} = require('../validators/requests.validators');

router.use(authenticate);

// ── Admin surface (declared first so no /:id route shadows it) ────────────
router.get('/admin', authorize('ADMIN'), validateListQuery, controller.listRequests);
router.get('/admin/stats', authorize('ADMIN'), controller.getRequestStats);
router.get('/admin/restrictions', authorize('ADMIN'), controller.listRestrictions);
router.post('/admin/restrictions', authorize('ADMIN'), validateRestriction, controller.createRestriction);
router.post('/admin/restrictions/:restrictionId/lift', authorize('ADMIN'), controller.liftRestriction);
router.post('/admin/:id/close', authorize('ADMIN'), controller.closeRequest);
router.post('/admin/:id/suspend', authorize('ADMIN'), validateSuspendRequest, controller.suspendRequest);
router.post('/admin/:id/restore', authorize('ADMIN'), controller.restoreRequest);
router.post('/admin/:id/attachments/remove', authorize('ADMIN'), controller.removeAttachment);
router.post('/admin/:id/reports/:reportId/review', authorize('ADMIN'), validateReviewReport, controller.reviewReport);

// ── Buyer / seller surface ────────────────────────────────────────────────
router.post('/', authorize('BUYER', { exact: true }), validateCreateRequest, controller.createRequest);
router.get('/', authorize(['BUYER', 'SELLER'], { exact: true }), controller.getMyRequests);
router.get('/shop/:shopId', authorize('SELLER'), controller.listShopRequests);
router.get('/:id', authorize(['BUYER', 'SELLER', 'ADMIN']), controller.getRequest);
router.get('/:id/messages', authorize(['BUYER', 'SELLER', 'ADMIN']), controller.getMessages);
router.post('/:id/messages', authorize(['BUYER', 'SELLER']), validateAddMessage, controller.addMessage);
// Either side quotes: the seller offers, the buyer counters.
router.post('/:id/offers', authorize(['BUYER', 'SELLER'], { exact: true }), validateMakeOffer, controller.makeOffer);
// Agreement confirmation — buyer and seller each confirm their own side.
router.post('/:id/accept', authorize(['BUYER', 'SELLER'], { exact: true }), controller.acceptOffer);
router.post('/:id/agreement/confirm', authorize(['BUYER', 'SELLER'], { exact: true }), validateConfirmAgreement, controller.confirmAgreement);
// Either side rejects a live offer it did not make.
router.post('/:id/offers/decline', authorize(['BUYER', 'SELLER'], { exact: true }), controller.declineOffer);
// Seller acknowledges the incoming request (PENDING → REVIEWING).
router.post('/:id/accept-request', authorize('SELLER'), controller.acceptRequest);
// Seller links a catalogue product to an offer (needed before conversion;
// also used to repair an agreement reached without one).
router.post('/:id/offers/product', authorize('SELLER'), controller.attachOfferProduct);
router.post('/:id/report', authorize(['BUYER', 'SELLER'], { exact: true }), validateReportRequest, controller.reportRequest);
router.post('/:id/cancel', authorize('BUYER', { exact: true }), controller.cancelRequest);
router.post('/:id/decline', authorize('SELLER'), controller.declineRequest);
router.post('/:id/convert-to-order', authorize('BUYER', { exact: true }), controller.convertToOrder);

module.exports = router;
