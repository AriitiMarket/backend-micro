const { ok } = require('../../../shared/utils/response');
const deliveryWebhookService = require('../services/deliveryWebhook.service');

async function handleStatusUpdate(req, res, next) {
  try {
    const { deliveryId, orderId, status, note } = req.body;
    // Delivery posts `providerId`; `partnerId` is the pre-rename spelling, still
    // sent by a delivery instance that has not been redeployed yet.
    const providerId = req.body.providerId || req.body.partnerId;
    const result = await deliveryWebhookService.notifyStatusUpdate(deliveryId, orderId, status, providerId, note);
    return ok(res, result);
  } catch (err) {
    next(err);
  }
}

module.exports = { handleStatusUpdate };
