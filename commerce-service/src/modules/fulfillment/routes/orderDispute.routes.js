const express = require('express');
const orderDisputeController = require('../controllers/orderDispute.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

const router = express.Router();

router.post('/', authenticate, orderDisputeController.createDispute);
router.patch('/:disputeId', authenticate, orderDisputeController.updateDispute);
router.get('/:disputeId', authenticate, orderDisputeController.getDispute);
router.get('/seller/disputes', authenticate, orderDisputeController.getSellerDisputes);
router.get('/admin/open', authenticate, orderDisputeController.getOpenDisputes);

module.exports = router;
