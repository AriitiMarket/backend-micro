const express = require('express');
const router = express.Router();
const { handlePaymentWebhook } = require('../controllers/paymentWebhook.controller');
const verifyPaymentWebhookSignature = require('../../../app/middleware/verifyWebhookSignature');

// Payment provider webhook — INTERNAL ONLY. Mounted at
// `/internal/commerce/payment-webhook` behind the cluster credential. The
// gateway enforces `requireInternalToken` at the edge; the service re-checks
// via gatewayOnly.
// FIX #2: Verify webhook signature before processing
router.post('/', verifyPaymentWebhookSignature, handlePaymentWebhook);

module.exports = router;
