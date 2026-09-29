const Location = require('../models/Location');

async function findById(id) { return Location.findById(id); }
async function findByName(name, parentId) {
  const query = { name };
  if (parentId) query.parentId = parentId;
  return Location.findOne(query);
}
async function create(data) { return Location.create(data); }
async function updateFields(id, fields) { return Location.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function deactivate(id) { return Location.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true }); }
async function activate(id) { return Location.findByIdAndUpdate(id, { $set: { isActive: true } }, { new: true }); }
async function findChildren(parentId) { return Location.find({ parentId, isActive: true }).sort({ name: 1 }); }
async function findRoots() { return Location.find({ parentId: null, isActive: true }).sort({ name: 1 }); }
async function findByType(type) { return Location.find({ type, isActive: true }).sort({ name: 1 }); }
async function search(query) {
  return Location.find({ $text: { $search: query }, isActive: true }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } }).limit(50);
}
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return Location.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Location.countDocuments(filter); }
async function findAncestors(id) {
  const ancestors = [];
  const seen = new Set([String(id)]);
  let current = await Location.findById(id);
  while (current && current.parentId) {
    const key = String(current.parentId);
    if (seen.has(key)) break;
    seen.add(key);
    current = await Location.findById(key);
    if (current) ancestors.unshift(current);
  }
  return ancestors;
}
async function findByIds(ids) { return Location.find({ _id: { $in: ids } }); }

module.exports = {
  findById, findByName, create, updateFields, deactivate, activate,
  findChildren, findRoots, findByType, search, findAll, count,
  findAncestors, findByIds,
};
