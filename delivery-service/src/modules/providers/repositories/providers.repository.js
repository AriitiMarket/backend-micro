const Provider = require('../models/Provider');

async function findById(id) { return Provider.findById(id); }
async function findByIdentityUserId(identityUserId) { return Provider.findOne({ identityUserId }); }
async function create(data) { return Provider.create(data); }
async function updateFields(id, fields) { return Provider.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return Provider.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Provider.countDocuments(filter); }
async function findAvailable(serviceId, zoneId) {
  const query = { status: 'available', 'availability.isOnline': true };
  if (serviceId) query.serviceId = serviceId;
  if (zoneId) {
    query.$or = [{ zoneId }, { zoneIds: zoneId }];
  }
  return Provider.find(query).sort({ activeDeliveries: 1, rating: -1 });
}
async function findAvailableForAssignment(serviceId, zoneId) {
  // $ifNull: seeded documents may pre-date the schema default — treat missing as 3.
  const query = { status: 'available', 'availability.isOnline': true, $expr: { $lt: ['$activeDeliveries', { $ifNull: ['$maxActiveAssignments', 3] }] } };
  if (serviceId) query.serviceId = serviceId;
  if (zoneId) {
    query.$or = [{ zoneId }, { zoneIds: zoneId }];
  }
  return Provider.find(query).sort({ activeDeliveries: 1, rating: -1 });
}

// Atomic & Idempotent workload management
async function incrementWorkload(id, workloadId) {
  return Provider.findOneAndUpdate(
    { 
      _id: id, 
      currentWorkloadIds: { $ne: String(workloadId) },
      $expr: { $lt: ['$activeDeliveries', { $ifNull: ['$maxActiveAssignments', 3] }] }
    },
    { 
      $inc: { activeDeliveries: 1 },
      $push: { currentWorkloadIds: String(workloadId) }
    },
    { new: true }
  );
}

async function decrementWorkload(id, workloadId) {
  return Provider.findOneAndUpdate(
    { 
      _id: id, 
      currentWorkloadIds: String(workloadId) 
    },
    { 
      $inc: { activeDeliveries: -1 },
      $pull: { currentWorkloadIds: String(workloadId) }
    },
    { new: true }
  );
}

async function incrementCompletedDeliveries(id) { 
  return Provider.findByIdAndUpdate(id, { $inc: { completedDeliveries: 1 } }, { new: true }); 
}

async function findByZone(zoneId) { return Provider.find({ $or: [{ zoneId }, { zoneIds: zoneId }] }).sort({ name: 1 }); }
async function findByPort(portId) { return Provider.find({ portId }).sort({ name: 1 }); }
// Used only to withdraw an application that is still `pending` (an applicant
// discarding their own un-reviewed record). Live providers are never deleted.
async function remove(id) { return Provider.findByIdAndDelete(id); }

module.exports = {
  findById, findByIdentityUserId, create, updateFields, findAll, count,
  findAvailable, findAvailableForAssignment, incrementWorkload,
  decrementWorkload, incrementCompletedDeliveries, findByZone, findByPort, remove,
};
