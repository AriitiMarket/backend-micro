const express = require('express');
const router = express.Router();
const controller = require('../controllers/sellerApplications.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Buyer-facing seller on-boarding (any authenticated Aritii account).
// POST   /seller-application      -> save / submit application
// GET    /seller-application/me   -> my current application + status
// DELETE /seller-application/me   -> discard an abandoned DRAFT
router.post('/', authenticate, controller.saveApplication);
router.get('/me', authenticate, controller.getMyApplication);
router.delete('/me', authenticate, controller.discardMyApplication);

// Admin reviewer routes — require ADMIN role.
router.get('/', authenticate, authorize('ADMIN'), controller.listApplications);
router.get('/:id', authenticate, authorize('ADMIN'), controller.getApplication);
router.post('/:id/approve', authenticate, authorize('ADMIN'), controller.approveApplication);
router.post('/:id/reject', authenticate, authorize('ADMIN'), controller.rejectApplication);
router.post('/:id/request-information', authenticate, authorize('ADMIN'), controller.requestInformation);
router.post('/:id/suspend', authenticate, authorize('ADMIN'), controller.suspendApplication);

module.exports = router;