const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/provider-wallet.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.get('/', authenticate, authorize('ADMIN'), ctrl.listPayouts);
router.put('/:id/approve', authenticate, authorize('ADMIN'), ctrl.approvePayout);
router.put('/:id/reject', authenticate, authorize('ADMIN'), ctrl.rejectPayout);

module.exports = router;
