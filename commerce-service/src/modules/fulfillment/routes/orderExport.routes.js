const express = require('express');
const orderExportController = require('../controllers/orderExport.controller');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.get('/csv', requireAuth, orderExportController.exportCSV);
router.get('/pdf', requireAuth, orderExportController.exportPDF);
router.get('/json/:orderId', requireAuth, orderExportController.exportJSON);

module.exports = router;
