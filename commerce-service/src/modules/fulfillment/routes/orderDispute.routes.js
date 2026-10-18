const express = require('express');
const orderDisputeController = require('../controllers/orderDispute.controller');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, orderDisputeController.createDispute);
router.patch('/:disputeId', requireAuth, orderDisputeController.updateDispute);
router.get('/:disputeId', requireAuth, orderDisputeController.getDispute);
router.get('/seller/disputes', requireAuth, orderDisputeController.getSellerDisputes);
router.get('/admin/open', requireAuth, orderDisputeController.getOpenDisputes);

module.exports = router;
