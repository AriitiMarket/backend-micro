'use strict';
// Delivery constants and status normalization tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_ALIASES,
  tryNormalizeDeliveryStatus,
  TERMINAL_DELIVERY_STATUSES,
  DELIVERY_EVENTS,
} = require('../../constants');

// ── DELIVERY_STATUSES ──
test('DELIVERY_STATUSES contains the canonical lifecycle values', () => {
  assert.deepEqual(DELIVERY_STATUSES, [
    'pending', 'assigned', 'reassigned', 'pickup', 'in_transit',
    'delivered', 'failed', 'cancelled',
  ]);
});

// ── tryNormalizeDeliveryStatus ──
test('tryNormalizeDeliveryStatus accepts canonical pending', () => {
  assert.equal(tryNormalizeDeliveryStatus('pending'), 'pending');
});

test('tryNormalizeDeliveryStatus accepts canonical assigned', () => {
  assert.equal(tryNormalizeDeliveryStatus('assigned'), 'assigned');
});

test('tryNormalizeDeliveryStatus accepts canonical delivered', () => {
  assert.equal(tryNormalizeDeliveryStatus('delivered'), 'delivered');
});

test('tryNormalizeDeliveryStatus maps legacy REQUESTED to pending', () => {
  assert.equal(tryNormalizeDeliveryStatus('REQUESTED'), 'pending');
});

test('tryNormalizeDeliveryStatus maps PENDING alias to pending', () => {
  assert.equal(tryNormalizeDeliveryStatus('PENDING'), 'pending');
});

test('tryNormalizeDeliveryStatus maps OUT_FOR_DELIVERY to in_transit', () => {
  assert.equal(tryNormalizeDeliveryStatus('OUT_FOR_DELIVERY'), 'in_transit');
});

test('tryNormalizeDeliveryStatus maps COMPLETED to delivered', () => {
  assert.equal(tryNormalizeDeliveryStatus('COMPLETED'), 'delivered');
});

test('tryNormalizeDeliveryStatus maps CANCELED to cancelled', () => {
  assert.equal(tryNormalizeDeliveryStatus('CANCELED'), 'cancelled');
});

test('tryNormalizeDeliveryStatus is case-insensitive', () => {
  assert.equal(tryNormalizeDeliveryStatus('Delivered'), 'delivered');
  assert.equal(tryNormalizeDeliveryStatus('DELIVERED'), 'delivered');
});

test('tryNormalizeDeliveryStatus returns null for unknown status', () => {
  assert.equal(tryNormalizeDeliveryStatus('returned'), null);
  assert.equal(tryNormalizeDeliveryStatus(''), null);
  assert.equal(tryNormalizeDeliveryStatus(null), null);
  assert.equal(tryNormalizeDeliveryStatus(undefined), null);
});

test('tryNormalizeDeliveryStatus maps removed pre-assignment stages to pending', () => {
  assert.equal(tryNormalizeDeliveryStatus('ready_for_pickup'), 'pending');
  assert.equal(tryNormalizeDeliveryStatus('validated'), 'pending');
  assert.equal(tryNormalizeDeliveryStatus('ready'), 'pending');
});

// ── TERMINAL_DELIVERY_STATUSES ──
test('TERMINAL_DELIVERY_STATUSES contains delivered and cancelled', () => {
  assert.deepEqual(TERMINAL_DELIVERY_STATUSES, ['delivered', 'cancelled']);
});

// ── DELIVERY_EVENTS ──
test('DELIVERY_EVENTS maps each status to an event name', () => {
  assert.equal(DELIVERY_EVENTS.pending, 'delivery.requeued');
  assert.equal(DELIVERY_EVENTS.assigned, 'delivery.assigned');
  assert.equal(DELIVERY_EVENTS.delivered, 'delivery.delivered');
  assert.equal(DELIVERY_EVENTS.cancelled, 'delivery.cancelled');
});
