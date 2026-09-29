// Delivery Service -> Commerce Service client.
//
// DIRECT internal call over the private network (COMMERCE_SERVICE_URL). The old
// implementation went through the API Gateway's internal namespace, which added
// a hop and signed every call as `gateway`: Commerce could not tell which
// service reported a status change, and a gateway outage silently stopped
// delivery status sync altogether.
//
// The target is Commerce's INTERNAL webhook surface. That path used to be a
// public `/delivery-webhook/status` route with no authentication at all —
// anybody who knew an order id could mark it delivered or cancelled.
const { createInternalClient } = require('../../shared/internal-client');
const { services } = require('../../app/config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.commerce.url,
  timeoutMs: parseInt(process.env.COMMERCE_CALL_TIMEOUT_MS, 10) || 5000,
  maxRetries: 2, // delivery state is persisted first; retry transient webhook failures
});

async function notifyStatusUpdate(deliveryId, orderId, status, providerId, note, proofOfDelivery = null) {
  const res = await client.requestOrThrow('POST', '/internal/commerce/delivery-webhook/status', {
    body: { deliveryId, orderId, status, providerId, note, proofOfDelivery },
  });
  return { status: res.status, body: res.body, ok: res.ok, code: res.code, requestId: res.requestId };
}

module.exports = {
  commerceClient: { notifyStatusUpdate },
  commerceClientInternals: client,
};
