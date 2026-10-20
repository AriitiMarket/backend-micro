const express = require('express');
const paymentReconciliationController = require('../controllers/paymentReconciliation.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

const router = express.Router();

router.post('/reconcile', authenticate, paymentReconciliationController.reconcile);
router.get('/report', authenticate, paymentReconciliationController.getReport);
router.post('/flag-discrepancy', authenticate, paymentReconciliationController.flagDiscrepancy);
router.post('/resolve-discrepancy', authenticate, paymentReconciliationController.resolveDiscrepancy);

module.exports = router;
