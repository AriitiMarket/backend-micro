const express = require('express');
const router = express.Router();
const { handleStatusUpdate } = require('../controllers/deliveryWebhook.controller');

router.post('/status', handleStatusUpdate);

module.exports = router;
