const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tracking.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Recording a tracking event is provider work: the assigned PROVIDER may post
// its own location/status updates and an ADMIN may post on any delivery
// (operational override). The controller additionally proves that a non-admin
// caller is the delivery's CURRENT provider, and derives providerId from that
// identity instead of trusting the payload.
router.post('/', authenticate, authorize(['ADMIN', 'PROVIDER']), ctrl.recordEvent);
// Nearby events expose raw tracking coordinates — admin operational view only.
router.get('/nearby', authenticate, authorize('ADMIN'), ctrl.findNearby);
router.get('/:deliveryId', authenticate, ctrl.getDeliveryHistory);
router.get('/:deliveryId/latest', authenticate, ctrl.getLatestLocation);

module.exports = router;
