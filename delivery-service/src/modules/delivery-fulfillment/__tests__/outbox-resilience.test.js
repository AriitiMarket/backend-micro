'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const DeliveryOutboxEvent = require('../models/DeliveryOutboxEvent');
const outboxRepo = require('../repositories/delivery-outbox.repository');
const outboxService = require('../services/delivery-outbox.service');
const { commerceClient } = require('../../../app/clients/commerce.client');

const TEST_DB_URI = process.env.ARITII_TEST_MONGO
  ? `${process.env.ARITII_TEST_MONGO}/aritii_outbox_resilience_test`
  : 'mongodb://127.0.0.1:27017/aritii_outbox_resilience_test';

test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_DB_URI);
  }
  await DeliveryOutboxEvent.deleteMany({});
});

test.after(async () => {
  await DeliveryOutboxEvent.deleteMany({});
  await mongoose.disconnect();
});

test('Outbox resilience: transitions to DEAD_LETTER after exceeding maxRetries', async () => {
  const deliveryId = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();

  // Enqueue event configured with maxRetries: 2
  const event = await outboxService.enqueueStatusEvent(
    { _id: deliveryId, orderId },
    'delivered',
    'Customer signed',
    null,
    { maxRetries: 2 }
  );

  assert.ok(event);
  assert.equal(event.state, 'PENDING');
  assert.equal(event.attempts, 0);
  assert.equal(event.retryCount, 0);
  assert.equal(event.maxRetries, 2);

  // Mock commerceClient to fail
  const originalNotify = commerceClient.notifyStatusUpdate;
  commerceClient.notifyStatusUpdate = async () => {
    throw new Error('Commerce webhook HTTP 503 Service Unavailable');
  };

  try {
    // Attempt 1: Should fail, increment attempts to 1, stay PENDING with future nextRetryAt
    const processed1 = await outboxService.deliverOne();
    assert.equal(processed1, true);

    const after1 = await DeliveryOutboxEvent.findById(event._id);
    assert.equal(after1.state, 'PENDING');
    assert.equal(after1.attempts, 1);
    assert.equal(after1.retryCount, 1);
    assert.ok(after1.nextRetryAt > new Date(Date.now() - 5000));
    assert.match(after1.lastError, /Commerce webhook HTTP 503/);

    // Fast-forward nextRetryAt and nextAttemptAt so claimNext picks it up again
    await DeliveryOutboxEvent.updateOne(
      { _id: event._id },
      { $set: { nextRetryAt: new Date(Date.now() - 1000), nextAttemptAt: new Date(Date.now() - 1000) } }
    );

    // Attempt 2: Should fail, attempts reaches maxRetries (2) -> DEAD_LETTER
    const processed2 = await outboxService.deliverOne();
    assert.equal(processed2, true);

    const after2 = await DeliveryOutboxEvent.findById(event._id);
    assert.equal(after2.state, 'DEAD_LETTER');
    assert.equal(after2.attempts, 2);
    assert.equal(after2.retryCount, 2);
    assert.match(after2.lastError, /Commerce webhook HTTP 503/);

    // Fast-forward again to confirm claimNext ignores DEAD_LETTER events
    await DeliveryOutboxEvent.updateOne(
      { _id: event._id },
      { $set: { nextRetryAt: new Date(Date.now() - 1000), nextAttemptAt: new Date(Date.now() - 1000) } }
    );

    const nextClaim = await outboxRepo.claimNext();
    assert.equal(nextClaim, null, 'DEAD_LETTER events must not be claimed again by outbox worker');
  } finally {
    commerceClient.notifyStatusUpdate = originalNotify;
  }
});
