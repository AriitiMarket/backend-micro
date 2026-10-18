const express = require('express');
const orderPriorityController = require('../controllers/orderPriority.controller');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, orderPriorityController.setPriority);
router.get('/:orderId', requireAuth, orderPriorityController.getPriority);
router.get('/vip/list', requireAuth, orderPriorityController.getVIPOrders);
router.post('/:orderId/reset', requireAuth, orderPriorityController.resetPriority);
router.get('/stats/summary', requireAuth, orderPriorityController.getPriorityStats);

module.exports = router;
