'use strict';

/**
 * Delivery Service -> Commerce Service client.
 *
 * Direct internal call over the private network (COMMERCE_SERVICE_URL).
 * Canonical location: src/app/clients/commerce.client.js
 */

const { createInternalClient } = require('@packages/service-client');
const { services } = require('../config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.commerce.url,
  timeoutMs: parseInt(process.env.COMMERCE_CALL_TIMEOUT_MS, 10) || 5000,
  maxRetries: 2, // delivery state is persisted first; retry transient webhook failures
});

/**
 * Notify Commerce Service of an updated delivery status via internal webhook.
 * 
 * @param {string} deliveryId - Delivery identifier
 * @param {string} orderId - Associated order identifier
 * @param {string} status - New delivery status (e.g. 'DELIVERED', 'FAILED', 'IN_TRANSIT')
 * @param {string} [providerId] - Delivery provider/driver ID
 * @param {string} [note] - Operational status update note
 * @param {object|null} [proofOfDelivery=null] - Optional proof of delivery payload or media reference
 * @returns {Promise<{ status: number, body: any, ok: boolean, code: string, requestId: string }>}
 */
async function notifyStatusUpdate(deliveryId, orderId, status, providerId, note, proofOfDelivery = null) {
  const res = await client.requestOrThrow('POST', '/internal/commerce/delivery-webhook/status', {
    body: { deliveryId, orderId, status, providerId, note, proofOfDelivery },
  });
  return { status: res.status, body: res.body, ok: res.ok, code: res.code, requestId: res.requestId };
}

const commerceClient = {
  notifyStatusUpdate,
};

module.exports = {
  commerceClient,
  notifyStatusUpdate,
  commerceClientInternals: client,
};
