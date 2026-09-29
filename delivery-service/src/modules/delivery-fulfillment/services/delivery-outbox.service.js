const outboxRepo = require('../repositories/delivery-outbox.repository');
const { commerceClient } = require('../../../integrations/commerce/client');

async function enqueueStatusEvent(delivery, status, note = '', proofOfDelivery = null) {
  if (!delivery?.orderId || !status) return null;
  const codReceiptKey = proofOfDelivery?.codConfirmed === true
    ? `:cod:${Number(proofOfDelivery.codCollectedAmount)}`
    : '';
  return outboxRepo.enqueue({
    eventKey: `${String(delivery._id)}:${status}${codReceiptKey}`,
    deliveryId: String(delivery._id),
    orderId: String(delivery.orderId),
    providerId: delivery.providerId ? String(delivery.providerId) : null,
    status,
    note: String(note || '').slice(0, 500),
    proofOfDelivery: proofOfDelivery || null,
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
    const attempts = (event.attempts || 0) + 1;
    const delay = Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 10)));
    await outboxRepo.markFailed(event._id, attempts, new Date(Date.now() + delay), err);
    console.error(`[delivery] Commerce outbox event ${event.eventKey} failed (${attempts}):`, err.message);
  }
  return true;
}

async function drain(limit = 50) {
  for (let index = 0; index < limit; index += 1) {
    if (!(await deliverOne())) break;
  }
}

module.exports = { enqueueStatusEvent, deliverOne, drain };
