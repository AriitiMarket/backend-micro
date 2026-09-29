const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/delivery-request.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/validate-address', authenticate, ctrl.validateAddress);
router.get('/', authenticate, ctrl.getRequests);
router.get('/:id', authenticate, ctrl.getRequest);
router.post('/', authenticate, ctrl.createRequest);

module.exports = router;
