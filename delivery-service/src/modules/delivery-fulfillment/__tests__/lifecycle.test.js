/**
 * Delivery domain lifecycle tests.
 *
 * The state machine, the cancellation boundaries, the proof-of-delivery rules
 * and the Commerce status mapping are pure functions — every rule the service
 * enforces at runtime is asserted here without a database, so a change to the
 * transition table or a proof rule is caught immediately.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../domain/lifecycle');
const constants = require('../../../shared/constants');
const moduleConstants = require('../constants');

test('status normalization accepts canonical, persisted and historical spellings', () => {
  assert.equal(lifecycle.normalizeStatus('PENDING'), 'pending');
  assert.equal(lifecycle.normalizeStatus('pending'), 'pending');
  assert.equal(lifecycle.normalizeStatus('REQUESTED'), 'pending');
  assert.equal(lifecycle.normalizeStatus('PICKED_UP'), 'pickup');
  assert.equal(lifecycle.normalizeStatus('IN_TRANSIT'), 'in_transit');
  // The retired pre-assignment stages collapse onto the ready pool, so a stale
  // client or an old bookmarked filter still resolves to the live state.
  assert.equal(lifecycle.normalizeStatus('READY'), 'pending');
  assert.equal(lifecycle.normalizeStatus('READY_FOR_PICKUP'), 'pending');
  assert.equal(lifecycle.normalizeStatus('VALIDATED'), 'pending');
  assert.equal(lifecycle.normalizeStatus('OUT_FOR_DELIVERY'), 'in_transit');
  assert.equal(lifecycle.normalizeStatus('ASSIGNED'), 'assigned');
  assert.equal(lifecycle.normalizeStatus('DELIVERED'), 'delivered');
  assert.throws(() => lifecycle.normalizeStatus('teleported'), /Unknown delivery status/);
  assert.throws(() => lifecycle.normalizeStatus(''), /is required/);
  // Every canonical lifecycle name is also accepted in its canonical UPPERCASE
  // spelling (the spelling the state machine and the admin UI use).
  for (const status of constants.DELIVERY_STATUSES) {
    assert.equal(
      lifecycle.normalizeStatus(status.toUpperCase()),
      status,
      `"${status.toUpperCase()}" must normalize to "${status}"`,
    );
  }
  // `optionalStatus` is the non-throwing spelling for query filters.
  assert.equal(lifecycle.optionalStatus('teleported'), null);
  assert.equal(lifecycle.optionalStatus(undefined), null);
});

test('the normal happy path is allowed end to end', () => {
  const steps = ['pending', 'assigned', 'pickup', 'in_transit', 'delivered'];
  for (let i = 0; i < steps.length - 1; i += 1) {
    assert.equal(
      lifecycle.assertTransition(steps[i], steps[i + 1]),
      true,
      `${steps[i]} -> ${steps[i + 1]} must be allowed`,
    );
  }
});

test('every documented valid transition is allowed', () => {
  for (const [from, targets] of Object.entries(constants.VALID_TRANSITIONS)) {
    for (const to of targets) {
      assert.equal(lifecycle.assertTransition(from, to), true, `${from} -> ${to} must be allowed`);
    }
  }
});

test('invalid transitions are rejected with a 409 business error', () => {
  const invalid = [
    ['pending', 'delivered'],
    ['pending', 'in_transit'],
    // Pickup without an assignment is not a delivery in progress.
    ['pending', 'pickup'],
    // The removed stages are not states any more: naming one is an unknown
    // status, and there is no transition table to consult.
    ['delivered', 'pending'],
    ['delivered', 'in_transit'],
    ['cancelled', 'assigned'],
    ['cancelled', 'pending'],
    ['assigned', 'delivered'],
    ['failed', 'delivered'],
  ];
  for (const [from, to] of invalid) {
    assert.throws(
      () => lifecycle.assertTransition(from, to),
      (err) => err.status === 409 && err.code === 'INVALID_TRANSITION',
      `${from} -> ${to} must be rejected`,
    );
  }
});

test('proof of delivery is normalized onto the stored field names', () => {
  const normalized = lifecycle.normalizeProofOfDelivery({
    photoUrl: 'https://cdn/photo.jpg',
    signatureUrl: 'https://cdn/sign.png',
    confirmedBy: 'buyer-1',
    codConfirmed: true,
    codCollectedAmount: '500',
  });
  assert.equal(normalized.photoReference, 'https://cdn/photo.jpg');
  assert.equal(normalized.signatureReference, 'https://cdn/sign.png');
  assert.equal(normalized.recipientReference, 'buyer-1');
  assert.equal(normalized.codConfirmed, true);
  assert.equal(normalized.codCollectedAmount, 500, 'the collected amount must survive normalization');
  assert.equal(lifecycle.normalizeProofOfDelivery(null), null);
});

test('COD completion needs the collected amount or an explicit confirmation', () => {
  const rules = { requireCodConfirmation: true };
  // Nothing reported: refused.
  assert.throws(
    () => lifecycle.assertProofSatisfied(null, rules, { expectedCodAmount: 500 }),
    (err) => err.code === 'PROOF_REQUIRED',
  );
  // Explicit confirmation is enough.
  assert.equal(lifecycle.assertProofSatisfied({ codConfirmed: true }, rules, { expectedCodAmount: 500 }), true);
  // Reporting the exact amount is equivalent evidence.
  assert.equal(lifecycle.assertProofSatisfied({ codCollectedAmount: 500 }, rules, { expectedCodAmount: 500 }), true);
  // A wrong amount is a reconciliation error, never a silent success.
  assert.throws(
    () => lifecycle.assertProofSatisfied({ codCollectedAmount: 400 }, rules, { expectedCodAmount: 500 }),
    (err) => err.code === 'PROOF_REQUIRED' || err.code === 'COD_AMOUNT_MISMATCH',
  );
});

test('photo and signature requirements are checked against the stored fields', () => {
  const rules = { requirePhoto: true, requireSignature: true };
  assert.throws(() => lifecycle.assertProofSatisfied({}, rules), (err) => err.code === 'PROOF_REQUIRED');
  assert.equal(
    lifecycle.assertProofSatisfied({ photoReference: 'a', signatureReference: 'b' }, rules),
    true,
  );
});

test('retry is limited to a failed delivery and to the configured cap', () => {
  assert.equal(lifecycle.assertRetryable('failed', 0), true);
  assert.throws(() => lifecycle.assertRetryable('pending', 0), (err) => err.code === 'RETRY_NOT_ALLOWED');
  assert.throws(
    () => lifecycle.assertRetryable('failed', moduleConstants.MAX_DELIVERY_RETRIES),
    (err) => err.code === 'RETRY_LIMIT_REACHED',
  );
});

test('Commerce is only notified for statuses it understands', () => {
  assert.equal(lifecycle.toCommerceStatus('delivered'), 'delivered');
  assert.equal(lifecycle.toCommerceStatus('pending'), 'pending');
  assert.equal(lifecycle.toCommerceStatus('pickup'), 'pickup');
  // Internal-only bookkeeping states must not reach Commerce.
  assert.equal(lifecycle.toCommerceStatus('return_requested'), null);
  assert.equal(lifecycle.toCommerceStatus('returned'), null);
  assert.equal(lifecycle.toCommerceStatus('not_a_status'), null);
});

test('milestone timestamps exist for every persistable status', () => {
  const withoutMilestone = ['pending']; // creation timestamp comes from `createdAt`
  for (const status of constants.DELIVERY_STATUSES) {
    if (withoutMilestone.includes(status)) continue;
    assert.ok(lifecycle.timestampFieldFor(status), `status ${status} must stamp a milestone timestamp`);
  }
});

test('the label map covers every status (the admin UI never renders a raw enum)', () => {
  for (const status of constants.DELIVERY_STATUSES) {
    const label = lifecycle.labelFor(status);
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0, `${status} must have a label`);
  }
});


test('terminal states never leave themselves', () => {
  assert.deepEqual(lifecycle.allowedTransitions('cancelled'), []);
  assert.deepEqual(lifecycle.allowedTransitions('delivered'), []);
  assert.equal(lifecycle.isTerminal('cancelled'), true);
  assert.equal(lifecycle.isTerminal('delivered'), true, 'delivery is the end of the road');
  // `failed` is BLOCKED but not terminal: the retry requeue is the one way out,
  // so treating it as terminal would strand every failed delivery forever.
  assert.equal(lifecycle.isTerminal('failed'), false);
  assert.equal(lifecycle.isBlocked('failed'), true);
  assert.deepEqual(lifecycle.allowedTransitions('failed'), ['pending', 'cancelled']);
});

test('every persisted status is reachable, blocked or terminal — none is dead', () => {
  // The rule the lifecycle is held to: a status nobody can write is a status the
  // console can only ever render. Each one must appear in the transition table.
  for (const status of constants.DELIVERY_STATUSES) {
    const targets = lifecycle.allowedTransitions(status);
    const reachable = Object.values(constants.VALID_TRANSITIONS).some((list) => list.includes(status));
    assert.ok(
      targets.length > 0 || reachable,
      `${status} has no outgoing transition and nothing transitions into it`,
    );
  }
  // And every transition target is itself a real status — a table that points at
  // a status the enum rejects is how `out_for_delivery` survived the last pass.
  for (const [from, targets] of Object.entries(constants.VALID_TRANSITIONS)) {
    assert.ok(constants.DELIVERY_STATUSES.includes(from), `${from} is not a delivery status`);
    for (const to of targets) {
      assert.ok(constants.DELIVERY_STATUSES.includes(to), `${from} -> ${to} targets a non-status`);
    }
  }
});


test('cancellation is only allowed while the delivery is not dispatched', () => {
  assert.equal(lifecycle.assertCancellable('pending'), true);
  assert.equal(lifecycle.assertCancellable('assigned'), true);
  // Guarded stage: the rider is on the customer leg, so an explicit
  // administrative override is required.
  assert.throws(
    () => lifecycle.assertCancellable('in_transit'),
    (err) => err.status === 409 && err.code === 'OVERRIDE_REQUIRED',
  );
  assert.equal(lifecycle.assertCancellable('in_transit', true), true);
  // Never: it already reached the customer.
  assert.throws(
    () => lifecycle.assertCancellable('delivered'),
    (err) => err.status === 409 && err.code === 'CANCEL_NOT_ALLOWED',
  );
});

test('a delivery cannot be completed from a dead state', () => {
  assert.equal(lifecycle.assertDeliverable('in_transit'), true);
  assert.equal(lifecycle.assertDeliverable('pickup'), true);
  for (const status of ['cancelled', 'failed']) {
    assert.throws(
      () => lifecycle.assertDeliverable(status),
      (err) => err.status === 409 && err.code === 'ALREADY_COMPLETED',
    );
  }
});
