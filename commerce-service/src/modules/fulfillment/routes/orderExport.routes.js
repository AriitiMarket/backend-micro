const express = require('express');
const orderExportController = require('../controllers/orderExport.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

const router = express.Router();

router.get('/csv', authenticate, orderExportController.exportCSV);
router.get('/pdf', authenticate, orderExportController.exportPDF);
router.get('/json/:orderId', authenticate, orderExportController.exportJSON);

module.exports = router;
