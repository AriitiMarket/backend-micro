const express = require('express');
const router = express.Router();
const commissionLedgerController = require('../controllers/commissionLedger.controller');
const { authenticate, authorize } = require('../../../app/middleware/authenticate');

router.use(authenticate);

router.post('/log', authorize('SYSTEM', 'ADMIN'), (req, res, next) => commissionLedgerController.logCommission(req, res, next));
router.get('/seller/:sellerId', (req, res, next) => commissionLedgerController.getCommissionHistory(req, res, next));
router.get('/seller/:sellerId/period', (req, res, next) => commissionLedgerController.getTotalCommissionForPeriod(req, res, next));
router.get('/seller/:sellerId/audit', authorize('ADMIN'), (req, res, next) => commissionLedgerController.auditCommissions(req, res, next));
router.get('/seller/:sellerId/by-reason', (req, res, next) => commissionLedgerController.getCommissionByReason(req, res, next));

module.exports = router;
