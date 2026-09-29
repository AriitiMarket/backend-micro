const deliveriesRepo = require('../repositories/delivery.repository');
const assignmentsRepo = require('../../operations/repositories/assignments.repository');
const trackingRepo = require('../../tracking/repositories/tracking.repository');
const providersService = require('../../providers/services/providers.service');
const deliveryOutbox = require('./delivery-outbox.service');
const auditClient = require('../../../shared/utils/audit-client');
const lifecycle = require('../domain/lifecycle');

async function _releaseProvider(providerId, assignmentId) {
  if (!providerId) return;
  if (assignmentId) await providersService.decrementWorkload(providerId, assignmentId);
  // Status transition is now handled automatically by decrementWorkload!
}

async function transitionDeliveryStatus(id, newStatus, actor, additionalData = {}, options = {}) {
  const delivery = await deliveriesRepo.findById(id);
  if (!delivery) throw Object.assign(new Error('Delivery not found'), { status: 404 });

  // A repeated terminal command is also the retry path for a downstream
  // Commerce notification that may have failed after this status was stored.
  if (delivery.status === newStatus) {
    const commerceStatus = lifecycle.toCommerceStatus(newStatus);
    if (delivery.orderId && commerceStatus) await deliveryOutbox.enqueueStatusEvent(
      delivery, commerceStatus, additionalData.note || '', additionalData.proofOfDelivery || delivery.proofOfDelivery || null,
    );
    return delivery;
  }

  // Verify transition
  lifecycle.assertTransition(delivery.status, newStatus);

  if (newStatus === 'cancelled') {
    lifecycle.assertCancellable(delivery.status, additionalData.override);
  } else if (newStatus === 'delivered') {
    lifecycle.assertDeliverable(delivery.status);
    if (delivery.proofRules) {
      lifecycle.assertProofSatisfied(additionalData.proofOfDelivery, delivery.proofRules);
    }
    if (delivery.proofRules?.requireCodConfirmation && Number(additionalData.proofOfDelivery?.codCollectedAmount) !== Number(delivery.paymentAmount)) {
      throw Object.assign(new Error('COD collection must equal the order total'), { status: 400, code: 'COD_AMOUNT_MISMATCH' });
    }
  }

  const updateFields = { status: newStatus };
  if (additionalData.failureReason) updateFields.failureReason = additionalData.failureReason;
  if (additionalData.cancellationReason) updateFields.cancellationReason = additionalData.cancellationReason;
  if (additionalData.proofOfDelivery) updateFields.proofOfDelivery = additionalData.proofOfDelivery;
  if (additionalData.note) updateFields.metadata = { ...delivery.metadata, lastNote: additionalData.note };
  
  // Set milestone timestamp dynamically
  const timestampField = lifecycle.timestampFieldFor(newStatus);
  const now = new Date();
  if (timestampField) {
    updateFields[timestampField] = now;
  }

  // Workload and side-effects
  if (newStatus === 'delivered') {
    if (delivery.providerId) {
      if (delivery.assignmentId && !options.deferProviderCompletion) await providersService.completeDelivery(delivery.providerId, delivery.assignmentId);
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

  // Tracking event
  await trackingRepo.create({
    deliveryId: id, 
    providerId: delivery.providerId || null,
    status: newStatus, 
    note: additionalData.note || additionalData.failureReason || additionalData.cancellationReason || '', 
    timestamp: now,
  }).catch(() => null);

  // Commerce webhook
  const commerceStatus = lifecycle.toCommerceStatus(newStatus);
  if (delivery.orderId && commerceStatus) await deliveryOutbox.enqueueStatusEvent(
    delivery, commerceStatus, additionalData.note || '', additionalData.proofOfDelivery || null,
  );

  // Audit event
  const eventName = lifecycle.eventFor(newStatus);
  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: eventName,
      targetEntity: 'delivery',
      targetId: id,
      adminId: actor ? actor.id : null,
      adminName: actor ? actor.name : null,
      newValue: { status: newStatus, oldStatus: delivery.status },
      reason: additionalData.cancellationReason || additionalData.failureReason || additionalData.note
    }).catch(() => null);
  }

  return deliveriesRepo.findById(id);
}

module.exports = { transitionDeliveryStatus };
