const deliveriesRepo = require('../repositories/delivery.repository');
const assignmentsRepo = require('../../operations/repositories/assignments.repository');
const trackingRepo = require('../../tracking/repositories/tracking.repository');
const providersService = require('../../providers/services/providers.service');
const deliveryOutbox = require('./delivery-outbox.service');
const auditClient = require('../../../shared/utils/audit-client');
const lifecycle = require('../domain/lifecycle');
const { FAILURE_NEXT_ACTIONS } = require('../constants');

/** Only the agreed next actions are stored on a failed attempt. */
function normalizeNextAction(value) {
  if (value === undefined || value === null || value === '') return '';
  return FAILURE_NEXT_ACTIONS.includes(value) ? value : '';
}

async function _releaseProvider(providerId, assignmentId) {
  if (!providerId) return;
  if (assignmentId) {
    await providersService.decrementWorkload(providerId, assignmentId);
    return;
  }
  // No assignment reference, so nothing can be decremented safely — but the
  // delivery is over, so the provider must not be left BUSY (and therefore
  // ineligible). Re-derive their availability from their current load.
  await providersService.reconcileAvailability(providerId);
}

/** Is this transition being driven by the delivery provider doing the work? */
function isProviderActor(actor) {
  return Boolean(actor && String(actor.role || '').toUpperCase() === 'PROVIDER');
}

async function transitionDeliveryStatus(id, newStatus, actor, additionalData = {}, options = {}) {
  const delivery = await deliveriesRepo.findById(id);
  if (!delivery) throw Object.assign(new Error('Delivery not found'), { status: 404 });

  // A repeated terminal command is also the retry path for a downstream
  // Commerce notification that may have failed after this status was stored.
  if (delivery.status === newStatus) {
    if (newStatus === 'delivered' && delivery.providerId) {
      await require('../../provider-wallet/services/provider-wallet.service').creditDelivery(delivery);
    }
    const commerceStatus = lifecycle.toCommerceStatus(newStatus);
    if (delivery.orderId && commerceStatus) await deliveryOutbox.enqueueStatusEvent(
      delivery, commerceStatus, additionalData.note || '', additionalData.proofOfDelivery || delivery.proofOfDelivery || null,
    );
    return delivery;
  }

  // Verify transition. Cancellation is checked FIRST so a completed delivery
  // answers "it is delivered, use the return flow" instead of the vaguer
  // "that transition is not allowed".
  if (newStatus === 'cancelled') lifecycle.assertCancellable(delivery.status, additionalData.override);
  lifecycle.assertTransition(delivery.status, newStatus);

  // One canonical proof object, stored only under the names the model defines.
  const proof = lifecycle.normalizeProofOfDelivery(additionalData.proofOfDelivery || additionalData.proof || null);
  let proofOverride = null;

  if (newStatus === 'delivered') {
    lifecycle.assertDeliverable(delivery.status);
    if (delivery.proofRules) {
      const requireProof = isProviderActor(actor);
      try {
        lifecycle.assertProofSatisfied(proof, delivery.proofRules, { expectedCodAmount: delivery.paymentAmount });
      } catch (err) {
        // A platform operator (admin console / back-office correction) may close
        // out a delivery whose proof the provider could not submit (rider app
        // offline, cash handed over outside the app). The bypass is never silent:
        // it is stored on the delivery and written to the audit log.
        if (requireProof || options.allowProofOverride === false) throw err;
        proofOverride = {
          at: new Date(),
          actorId: actor ? actor.id : null,
          reason: additionalData.note || additionalData.reason || 'Completed by a platform operator without proof',
          missing: (err.errors || []).map(String),
        };
      }
    }
  }

  // `reason` is the field every client sends for a failure or a cancellation;
  // the legacy spellings are still accepted. Without this the cause of a failed
  // or cancelled delivery was never persisted at all.
  const failureReason = additionalData.failureReason || (newStatus === 'failed' ? additionalData.reason : '');
  const cancellationReason = additionalData.cancellationReason || (newStatus === 'cancelled' ? additionalData.reason : '');

  const updateFields = { status: newStatus };
  if (failureReason) updateFields.failureReason = String(failureReason).slice(0, 500);
  if (cancellationReason) updateFields.cancellationReason = String(cancellationReason).slice(0, 500);
  if (proof) updateFields.proofOfDelivery = proof;
  if (additionalData.note || proofOverride) {
    updateFields.metadata = {
      ...(delivery.metadata || {}),
      ...(additionalData.note ? { lastNote: additionalData.note } : {}),
      ...(proofOverride ? { proofOverride } : {}),
    };
  }

  // A failed delivery records WHY and WHAT HAPPENS NEXT, so the recovery path
  // (retry / reschedule / return / escalation) is part of the record.
  if (newStatus === 'failed') {
    const attempts = (delivery.attempts || []).map((attempt) => (attempt && attempt.toObject ? attempt.toObject() : attempt));
    attempts.push({
      at: new Date(),
      reason: updateFields.failureReason || '',
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.name : null,
      actorRole: actor ? actor.role || null : null,
      evidence: additionalData.evidence ?? null,
      nextAction: normalizeNextAction(additionalData.nextAction),
    });
    updateFields.attempts = attempts;
    updateFields.retryCount = (delivery.retryCount || 0) + 1;
    if (normalizeNextAction(additionalData.nextAction)) updateFields.nextAction = normalizeNextAction(additionalData.nextAction);
  }
  
  // Set milestone timestamp dynamically
  const timestampField = lifecycle.timestampFieldFor(newStatus);
  const now = new Date();
  if (timestampField) {
    updateFields[timestampField] = now;
  }

  // Workload and side-effects
  if (newStatus === 'delivered') {
    if (delivery.providerId) {
      if (delivery.assignmentId && !options.deferProviderCompletion) {
        await providersService.completeDelivery(delivery.providerId, delivery.assignmentId);
      } else if (!options.deferProviderCompletion) {
        // Success with no assignment reference to decrement: nothing else will
        // free this provider, so still re-derive their availability — a
        // completed delivery must never leave someone stuck BUSY. (When
        // `deferProviderCompletion` is set, the batch flow owns the release and
        // frees the whole batch once it completes.)
        await providersService.reconcileAvailability(delivery.providerId);
      }
      await assignmentsRepo.cancelActiveByDelivery(id);
    }
  } else if (newStatus === 'failed' || newStatus === 'cancelled') {
    if (delivery.providerId) {
      await _releaseProvider(delivery.providerId, delivery.assignmentId);
      await assignmentsRepo.cancelActiveByDelivery(id);
    }
  } else if (newStatus === 'reassigned') {
    if (delivery.providerId && delivery.assignmentId) {
      await providersService.decrementWorkload(delivery.providerId, delivery.assignmentId);
    }
  }

  // Save changes
  await deliveriesRepo.updateFields(id, updateFields);

  // Ledger credit is keyed by delivery id, so terminal retries can safely
  // repair a credit interrupted after the delivery status was stored.
  if (newStatus === 'delivered' && delivery.providerId) {
    const deliverySnapshot = typeof delivery.toObject === 'function' ? delivery.toObject() : { ...delivery };
    await require('../../provider-wallet/services/provider-wallet.service').creditDelivery({ ...deliverySnapshot, ...updateFields });
  }

  // Tracking event — history is the delivery's audit trail, so a failure to
  // record it is logged (it used to be swallowed silently, which made missing
  // history events undiagnosable) without failing the state change itself.
  await trackingRepo.create({
    deliveryId: id,
    providerId: delivery.providerId || null,
    status: newStatus,
    note: additionalData.note || failureReason || cancellationReason || '',
    timestamp: now,
  }).catch((err) => {
    console.error(`[delivery] failed to record tracking event ${newStatus} for delivery ${id}:`, err.message);
    return null;
  });

  // Commerce webhook
  const commerceStatus = lifecycle.toCommerceStatus(newStatus);
  if (delivery.orderId && commerceStatus) await deliveryOutbox.enqueueStatusEvent(
    delivery, commerceStatus, additionalData.note || '', proof || null,
  );

  // Audit event
  const eventName = lifecycle.eventFor(newStatus);
  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: eventName,
      level: proofOverride ? 'WARNING' : 'INFO',
      targetEntity: 'delivery',
      targetId: id,
      adminId: actor ? actor.id : null,
      adminName: actor ? actor.name : null,
      newValue: { status: newStatus, oldStatus: delivery.status, ...(proofOverride ? { proofOverride } : {}) },
      reason: cancellationReason || failureReason || (proofOverride && proofOverride.reason) || additionalData.note
    }).catch(() => null);
  }

  return deliveriesRepo.findById(id);
}

module.exports = { transitionDeliveryStatus };
