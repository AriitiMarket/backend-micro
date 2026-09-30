const deliveriesRepo = require('../repositories/delivery.repository');
const assignmentsRepo = require('../../operations/repositories/assignments.repository');
const trackingRepo = require('../../tracking/repositories/tracking.repository');
const providersService = require('../../providers/services/providers.service');
const { commerceClient } = require('../../../integrations/commerce/client');
const { VALID_TRANSITIONS } = require('../../../shared/constants');
const validators = require('../validators');

const TERMINAL_STATUSES = ['delivered', 'failed', 'cancelled'];

/**
 * Create a delivery directly (admin operation).
 *
 * The same contract the Commerce handoff uses, validated the same way: an admin
 * creating a delivery by hand must not be able to persist a record with no
 * destination, a negative quantity or an impossible coordinate pair.
 */
async function createDelivery(data) {
  validators.validateDeliveryCreationInput(data);
  return deliveriesRepo.create({
    ...data,
    paymentMethod: validators.normalizePaymentMethod(data.paymentMethod) || 'COD',
  });
}

async function getDelivery(id) {
  const delivery = await deliveriesRepo.findById(id);
  if (!delivery) throw Object.assign(new Error('Delivery not found'), { status: 404 });
  return delivery;
}

async function getDeliveryByOrderId(orderId) { return deliveriesRepo.findByOrderId(orderId); }

const { transitionDeliveryStatus } = require('./delivery-status.service');

async function updateStatus(id, newStatus, additionalData = {}, actor = null) {
  return transitionDeliveryStatus(id, newStatus, actor, additionalData);
}

function buildTimeline(delivery) {
  const steps = [
    { stage: 'order_created', label: 'Order Created', timestamp: delivery.createdAt, status: 'pending' },
  ];
  if (delivery.assignedAt) steps.push({ stage: 'assigned', label: 'Assigned', timestamp: delivery.assignedAt, status: 'assigned' });
  if (delivery.pickedUpAt) steps.push({ stage: 'picked_up', label: 'Picked Up', timestamp: delivery.pickedUpAt, status: 'pickup' });
  if (delivery.reassignedAt) steps.push({ stage: 'reassigned', label: 'Reassigned', timestamp: delivery.reassignedAt, status: 'reassigned' });
  // in_transit has no dedicated timestamp — approximate from tracking if present
  if (delivery.status === 'in_transit' || delivery.status === 'delivered' || delivery.status === 'failed') {
    steps.push({ stage: 'in_transit', label: 'In Transit', timestamp: delivery.pickedUpAt || delivery.updatedAt, status: 'in_transit' });
  }
  if (delivery.deliveredAt) steps.push({ stage: 'delivered', label: 'Delivered', timestamp: delivery.deliveredAt, status: 'delivered' });
  if (delivery.failedAt) steps.push({ stage: 'failed', label: 'Failed', timestamp: delivery.failedAt, status: 'failed' });
  if (delivery.cancelledAt) steps.push({ stage: 'cancelled', label: 'Cancelled', timestamp: delivery.cancelledAt, status: 'cancelled' });
  return steps.filter(s => s.timestamp).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

async function getDeliveryDetail(id) {
  const delivery = await getDelivery(id);
  const [provider, assignments, events] = await Promise.all([
    delivery.providerId ? providersService.getProvider(delivery.providerId).catch(() => null) : Promise.resolve(null),
    assignmentsRepo.findByDeliveryId(id),
    trackingRepo.findByDeliveryId(id).catch(() => []),
  ]);
  const timeline = buildTimeline(delivery);
  const trackingTimeline = events.map(e => ({
    stage: e.status, label: e.status, timestamp: e.timestamp, note: e.note || '',
  }));
  return {
    ...delivery.toObject ? delivery.toObject() : delivery,
    provider,
    timeline,
    trackingEvents: trackingTimeline,
    assignmentHistory: assignments,
  };
}

async function getDeliveryHistory(id) {
  const detail = await getDeliveryDetail(id);
  return { timeline: detail.timeline, trackingEvents: detail.trackingEvents, assignmentHistory: detail.assignmentHistory };
}

async function getDeliveries(filter = {}, options = {}) { return deliveriesRepo.findAll(filter, options); }
async function countDeliveries(filter = {}) { return deliveriesRepo.count(filter); }
async function getDeliveriesByStatus(status) { return deliveriesRepo.findByStatus(status); }
async function getDeliveriesByProvider(providerId) { return deliveriesRepo.findByProviderId(providerId); }

module.exports = {
  createDelivery, getDelivery, getDeliveryByOrderId, updateStatus,
  getDeliveryDetail, getDeliveryHistory,
  getDeliveries, countDeliveries, getDeliveriesByStatus, getDeliveriesByProvider,
};
