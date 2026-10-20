const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/provider-wallet.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.get('/me', authenticate, authorize(['PROVIDER', 'ADMIN']), ctrl.getMyWallet);
router.put('/me/payout-account', authenticate, authorize('PROVIDER'), ctrl.setPayoutAccount);
router.post('/me/payouts', authenticate, authorize('PROVIDER'), ctrl.requestPayout);
router.get('/admin', authenticate, authorize('ADMIN'), ctrl.listWallets);
router.put('/admin/:providerId/payout-account', authenticate, authorize('ADMIN'), ctrl.verifyAccount);

module.exports = router;
