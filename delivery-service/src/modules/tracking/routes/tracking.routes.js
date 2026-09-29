const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tracking.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.post('/', authenticate, authorize('ADMIN'), ctrl.recordEvent);
// Nearby events expose raw tracking coordinates — admin operational view only.
router.get('/nearby', authenticate, authorize('ADMIN'), ctrl.findNearby);
router.get('/:deliveryId', authenticate, ctrl.getDeliveryHistory);
router.get('/:deliveryId/latest', authenticate, ctrl.getLatestLocation);

module.exports = router;
