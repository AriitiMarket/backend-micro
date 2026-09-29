const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/providerApplications.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Delivery provider applications — any authenticated Aritii account may apply.
//
// POST   /provider-application            -> submit / amend my application
// GET    /provider-application/me          -> my application + status
// DELETE /provider-application/me          -> withdraw (only while `pending`)
//
// The applicant never supplies an identity: the controller scopes every action
// to the authenticated caller (req.user.id).
router.post('/', authenticate, ctrl.submitApplication);
router.get('/me', authenticate, ctrl.getMyApplication);
router.delete('/me', authenticate, ctrl.withdrawMyApplication);

// Admin review queue — requires ADMIN.
router.get('/', authenticate, authorize('ADMIN'), ctrl.listApplications);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getApplication);
router.post('/:id/approve', authenticate, authorize('ADMIN'), ctrl.approveApplication);
router.post('/:id/reject', authenticate, authorize('ADMIN'), ctrl.rejectApplication);

module.exports = router;
