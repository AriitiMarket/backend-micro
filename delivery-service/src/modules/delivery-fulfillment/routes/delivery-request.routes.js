const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/delivery-request.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/validate-address', authenticate, ctrl.validateAddress);
router.get('/', authenticate, ctrl.getRequests);
router.get('/:id', authenticate, ctrl.getRequest);
// Creation is available only on the service-authenticated internal Commerce
// handoff. Public authenticated actors cannot submit arbitrary order parties.

module.exports = router;
