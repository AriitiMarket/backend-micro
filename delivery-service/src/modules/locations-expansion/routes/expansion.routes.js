const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/expansion.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

router.get('/:id/readiness', authenticate, authorize('ADMIN'), ctrl.getReadiness);
router.patch('/:id/expansion', authenticate, authorize('ADMIN'), ctrl.updateExpansionStatus);

module.exports = router;
