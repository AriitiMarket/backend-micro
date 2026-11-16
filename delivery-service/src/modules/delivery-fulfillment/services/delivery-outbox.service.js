'use strict';

const outboxRepo = require('../repositories/delivery-outbox.repository');
const { commerceClient } = require('../../../app/clients/commerce.client');

const DEFAULT_MAX_RETRIES = parseInt(process.env.DELIVERY_OUTBOX_MAX_RETRIES, 10) || 5;

async function enqueueStatusEvent(delivery, status, note = '', proofOfDelivery = null, options = {}) {
  if (!delivery?.orderId || !status) return null;
  const codReceiptKey = proofOfDelivery?.codConfirmed === true
    ? `:cod:${Number(proofOfDelivery.codCollectedAmount)}`
    : '';
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
  return outboxRepo.enqueue({
    eventKey: `${String(delivery._id)}:${status}${codReceiptKey}`,
    deliveryId: String(delivery._id),
    orderId: String(delivery.orderId),
    providerId: delivery.providerId ? String(delivery.providerId) : null,
    status,
    note: String(note || '').slice(0, 500),
    proofOfDelivery: proofOfDelivery || null,
    maxRetries,
    attempts: 0,
    retryCount: 0,
    nextAttemptAt: new Date(),
    nextRetryAt: new Date(),
  });
}

async function deliverOne() {
  const event = await outboxRepo.claimNext();
  if (!event) return false;
  try {
    await commerceClient.notifyStatusUpdate(
      event.deliveryId,
      event.orderId,
      event.status,
      event.providerId,
      event.note,
      event.proofOfDelivery,
    );
    await outboxRepo.markSent(event._id);
  } catch (err) {
    const attempts = ((event.retryCount ?? event.attempts) || 0) + 1;
    const maxRetries = event.maxRetries || DEFAULT_MAX_RETRIES;
    const isDeadLetter = attempts >= maxRetries;
    // Exponential backoff: 1s, 2s, 4s, 8s... capped at 15 minutes
    const delay = Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 10)));
    const nextRetryAt = new Date(Date.now() + delay);
    await outboxRepo.markFailed(event._id, attempts, nextRetryAt, err, isDeadLetter);
    console.error(
      `[delivery] Commerce outbox event ${event.eventKey} failed (${attempts}/${maxRetries})${isDeadLetter ? ' -> DEAD_LETTER' : ''}:`,
      err.message
    );
  }
  return true;
}

async function drain(limit = 50) {
  for (let index = 0; index < limit; index += 1) {
    if (!(await deliverOne())) break;
  }
}

module.exports = { enqueueStatusEvent, deliverOne, drain, DEFAULT_MAX_RETRIES };
