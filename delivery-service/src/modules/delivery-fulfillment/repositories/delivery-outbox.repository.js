const DeliveryOutboxEvent = require('../models/DeliveryOutboxEvent');

function enqueue(event) {
  return DeliveryOutboxEvent.findOneAndUpdate(
    { eventKey: event.eventKey },
    { $setOnInsert: event },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function claimNext(now = new Date()) {
  const staleLock = new Date(now.getTime() - 2 * 60 * 1000);
  return DeliveryOutboxEvent.findOneAndUpdate({
    $or: [
      { state: 'PENDING', nextAttemptAt: { $lte: now } },
      { state: 'PROCESSING', lockedAt: { $lt: staleLock } },
    ],
  }, { $set: { state: 'PROCESSING', lockedAt: now } }, {
    sort: { createdAt: 1 }, new: true,
  });
}

function markSent(id, now = new Date()) {
  return DeliveryOutboxEvent.findByIdAndUpdate(id, {
    $set: { state: 'SENT', sentAt: now, lockedAt: null, lastError: '' },
  }, { new: true });
}

function markFailed(id, attempts, nextAttemptAt, error) {
  return DeliveryOutboxEvent.findByIdAndUpdate(id, {
    $set: {
      state: 'PENDING', attempts, nextAttemptAt, lockedAt: null,
      lastError: String(error?.message || error || 'Delivery webhook failed').slice(0, 1000),
    },
  }, { new: true });
}

module.exports = { enqueue, claimNext, markSent, markFailed };
