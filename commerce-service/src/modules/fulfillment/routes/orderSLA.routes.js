const express = require('express');
const orderSLAController = require('../controllers/orderSLA.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

const router = express.Router();

router.post('/', authenticate, orderSLAController.setSLA);
router.get('/:orderId/compliance', authenticate, orderSLAController.checkCompliance);
router.get('/:orderId/status', authenticate, orderSLAController.getStatus);
router.get('/seller/breaches', authenticate, orderSLAController.getBreaches);

module.exports = router;
