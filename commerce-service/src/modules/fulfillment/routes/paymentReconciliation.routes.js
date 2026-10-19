const express = require('express');
const paymentReconciliationController = require('../controllers/paymentReconciliation.controller');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.post('/reconcile', requireAuth, paymentReconciliationController.reconcile);
router.get('/report', requireAuth, paymentReconciliationController.getReport);
router.post('/flag-discrepancy', requireAuth, paymentReconciliationController.flagDiscrepancy);
router.post('/resolve-discrepancy', requireAuth, paymentReconciliationController.resolveDiscrepancy);

module.exports = router;
