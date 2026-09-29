const express = require('express');
const router = express.Router();
const controller = require('../controllers/disputes.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Party endpoints — a buyer or a seller may file and read their OWN dispute.
// Both handlers re-check ownership against the stored parties: the create used
// to trust `buyerId` from the body and the read had no ownership check at all,
// so any authenticated account could read any dispute and file one as someone
// else (IDOR).
router.post('/', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), controller.createDispute);
router.get('/:id', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), controller.getDispute);

// Admin-only endpoints
router.get('/', authenticate, authorize('ADMIN'), controller.listDisputes);
router.patch('/:id/status', authenticate, authorize('ADMIN'), controller.updateDisputeStatus);
router.patch('/:id/priority', authenticate, authorize('ADMIN'), controller.updateDisputePriority);
router.post('/:id/notes', authenticate, authorize('ADMIN'), controller.addNote);
router.post('/:id/evidence', authenticate, authorize('ADMIN'), controller.addEvidence);
router.post('/:id/assign', authenticate, authorize('ADMIN'), controller.assignDispute);
router.post('/:id/resolve', authenticate, authorize('ADMIN'), controller.resolveDispute);
router.post('/:id/reject', authenticate, authorize('ADMIN'), controller.rejectDispute);
router.post('/:id/close', authenticate, authorize('ADMIN'), controller.closeDispute);

// Stats endpoints
router.get('/admin/stats', authenticate, authorize('ADMIN'), controller.getStats);
router.get('/admin/recent', authenticate, authorize('ADMIN'), controller.getRecentDisputes);

module.exports = router;
