const express = require('express');
const router = express.Router();
const paymentLedgerController = require('../controllers/paymentLedger.controller');
const { authenticate, authorize } = require('../../../app/middleware/authenticate');

router.use(authenticate);

router.post('/log', (req, res, next) => paymentLedgerController.logPaymentChange(req, res, next));
router.get('/:paymentId', (req, res, next) => paymentLedgerController.getPaymentHistory(req, res, next));
router.get('/:paymentId/audit', authorize('ADMIN'), (req, res, next) => paymentLedgerController.auditPayment(req, res, next));
router.get('/failed', authorize('ADMIN'), (req, res, next) => paymentLedgerController.getFailedPayments(req, res, next));
router.get('/stats', authorize('ADMIN'), (req, res, next) => paymentLedgerController.getLedgerStats(req, res, next));

module.exports = router;
