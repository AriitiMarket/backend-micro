const express = require('express');
const orderPriorityController = require('../controllers/orderPriority.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

const router = express.Router();

router.post('/', authenticate, orderPriorityController.setPriority);
router.get('/:orderId', authenticate, orderPriorityController.getPriority);
router.get('/vip/list', authenticate, orderPriorityController.getVIPOrders);
router.post('/:orderId/reset', authenticate, orderPriorityController.resetPriority);
router.get('/stats/summary', authenticate, orderPriorityController.getPriorityStats);

module.exports = router;
