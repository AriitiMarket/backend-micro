const AssignmentBatch = require('../models/AssignmentBatch');

async function findById(id) { return AssignmentBatch.findById(id); }
async function findByReference(reference) { return AssignmentBatch.findOne({ reference }); }
async function create(data) { return AssignmentBatch.create(data); }

async function updateFields(id, fields) {
  return AssignmentBatch.findByIdAndUpdate(id, { $set: fields }, { new: true });
}

async function findAll(filter = {}, options = {}) {
  const { limit = 50, skip = 0, sort = { assignedAt: -1 } } = options;
  return AssignmentBatch.find(filter).sort(sort).skip(skip).limit(limit);
}

async function count(filter = {}) { return AssignmentBatch.countDocuments(filter); }

async function findActiveByProviderId(providerId) {
  return AssignmentBatch.find({
    providerId,
    status: { $in: ['waiting_acceptance', 'accepted', 'picking_up', 'picked_up', 'in_transit'] },
  });
}

/** Any non-terminal batch that already holds one of these deliveries. */
async function findActiveByDeliveryIds(deliveryIds = []) {
  if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) return [];
  return AssignmentBatch.find({
    'deliveries.deliveryId': { $in: deliveryIds },
    status: { $in: ['waiting_acceptance', 'accepted', 'picking_up', 'picked_up', 'in_transit'] },
  });
}

/** Next human reference, e.g. DL-2045. */
async function nextReference() {
  const last = await AssignmentBatch.findOne({}, { reference: 1 }).sort({ createdAt: -1 }).lean();
  let n = 2000;
  if (last && /^DL-(\d+)$/.test(last.reference)) {
    n = Math.max(n, parseInt(last.reference.slice(3), 10));
  }
  return `DL-${n + 1}`;
}

module.exports = {
  findById, findByReference, create, updateFields,
  findAll, count, findActiveByProviderId, findActiveByDeliveryIds, nextReference,
};