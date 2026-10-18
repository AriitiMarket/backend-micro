const express = require('express');
const orderSLAController = require('../controllers/orderSLA.controller');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, orderSLAController.setSLA);
router.get('/:orderId/compliance', requireAuth, orderSLAController.checkCompliance);
router.get('/:orderId/status', requireAuth, orderSLAController.getStatus);
router.get('/seller/breaches', requireAuth, orderSLAController.getBreaches);

module.exports = router;
