const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/assignments.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.get('/', authenticate, ctrl.getAssignments);
// Must stay above `/:id` — otherwise "eligible-partners" is read as an id.
router.get('/eligible-partners', authenticate, authorize('ADMIN'), ctrl.eligibleProviders);
router.get('/:id', authenticate, ctrl.getAssignment);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createAssignment);
router.post('/automatic', authenticate, authorize('ADMIN'), ctrl.automaticAssignment);
router.post('/:id/respond', authenticate, ctrl.respondToAssignment);
// The provider who holds the assignment moves their own delivery forward.
router.post('/:id/advance', authenticate, ctrl.advanceAssignment);
router.post('/reassign', authenticate, authorize('ADMIN'), ctrl.reassign);

module.exports = router;
