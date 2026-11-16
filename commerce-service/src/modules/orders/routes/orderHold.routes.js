const express = require('express');
const router = express.Router();
const orderHoldController = require('../controllers/orderHold.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.use(authenticate);

router.post('/', (req, res, next) => orderHoldController.holdOrder(req, res, next));
router.get('/:orderId', (req, res, next) => orderHoldController.getHoldStatus(req, res, next));
router.post('/:orderId/release', (req, res, next) => orderHoldController.releaseHold(req, res, next));
router.get('/:orderId/history', (req, res, next) => orderHoldController.getHoldHistory(req, res, next));
router.get('/seller/held-orders', (req, res, next) => orderHoldController.getHeldOrdersBySeller(req, res, next));

module.exports = router;
