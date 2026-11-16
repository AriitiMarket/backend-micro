const express = require('express');
const router = express.Router();
const controller = require('../controllers/disputes.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Order-dispute specific routes (placed before /:id)
router.get('/seller/disputes', authenticate, controller.getSellerDisputes);
router.get('/admin/open', authenticate, controller.getOpenDisputes);

// Stats endpoints
router.get('/admin/stats', authenticate, authorize('ADMIN'), controller.getStats);
router.get('/admin/recent', authenticate, authorize('ADMIN'), controller.getRecentDisputes);

// Party endpoints — a buyer or a seller may file and read their OWN dispute
router.post('/', authenticate, (req, res, next) => {
  if (req.body.reason && !req.body.subject) {
    return controller.createOrderDispute(req, res, next);
  }
  return authorize(['BUYER', 'SELLER', 'ADMIN'])(req, res, () => controller.createDispute(req, res, next));
});

// Admin-only endpoints
router.get('/', authenticate, authorize('ADMIN'), controller.listDisputes);

// Patch on dispute (supports both /order-dispute/:disputeId and /disputes/:id/status)
router.patch('/:disputeId', authenticate, (req, res, next) => {
  return controller.updateOrderDispute(req, res, next);
});

router.patch('/:id/status', authenticate, authorize('ADMIN'), controller.updateDisputeStatus);
router.patch('/:id/priority', authenticate, authorize('ADMIN'), controller.updateDisputePriority);
router.post('/:id/notes', authenticate, authorize('ADMIN'), controller.addNote);
router.post('/:id/evidence', authenticate, authorize('ADMIN'), controller.addEvidence);
router.post('/:id/assign', authenticate, authorize('ADMIN'), controller.assignDispute);
router.post('/:id/resolve', authenticate, authorize('ADMIN'), controller.resolveDispute);
router.post('/:id/reject', authenticate, authorize('ADMIN'), controller.rejectDispute);
router.post('/:id/close', authenticate, authorize('ADMIN'), controller.closeDispute);

router.get('/:id', authenticate, (req, res, next) => {
  return controller.getDispute(req, res, next);
});

module.exports = router;
