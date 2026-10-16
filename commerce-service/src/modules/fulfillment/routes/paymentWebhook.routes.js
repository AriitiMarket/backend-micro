const express = require('express');
const router = express.Router();
const { handlePaymentWebhook } = require('../controllers/paymentWebhook.controller');

// Payment provider webhook — INTERNAL ONLY. Mounted at
// `/internal/commerce/payment-webhook` behind the cluster credential. The
// gateway enforces `requireInternalToken` at the edge; the service re-checks
// via gatewayOnly.
router.post('/', handlePaymentWebhook);

module.exports = router;
