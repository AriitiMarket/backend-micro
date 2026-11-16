const paymentWebhookService = require('../services/paymentWebhook.service');
const { ok } = require('../../../shared/utils/response');

async function handlePaymentWebhook(req, res, next) {
  try {
    const result = await paymentWebhookService.handleWebhook(req.body);
    return ok(res, result, 'Payment webhook processed');
  } catch (err) { return next(err); }
}

module.exports = { handlePaymentWebhook };
