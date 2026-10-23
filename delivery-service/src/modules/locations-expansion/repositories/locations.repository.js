const mongoose = require('mongoose');
const Location = require('../models/Location');

function isValidId(id) {
  return id && id !== 'undefined' && id !== 'null' && mongoose.isValidObjectId(id);
}

async function findById(id) {
  if (!isValidId(id)) return null;
  return Location.findById(id);
}

async function findByName(name, parentId) {
  const query = { name };
  if (parentId) {
    if (!isValidId(parentId)) return null;
    query.parentId = parentId;
  }
  return Location.findOne(query);
}
async function create(data) { return Location.create(data); }
async function updateFields(id, fields) {
  if (!isValidId(id)) return null;
  return Location.findByIdAndUpdate(id, { $set: fields }, { new: true });
}
async function deactivate(id) {
  if (!isValidId(id)) return null;
  return Location.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
}
async function activate(id) {
  if (!isValidId(id)) return null;
  return Location.findByIdAndUpdate(id, { $set: { isActive: true } }, { new: true });
}
async function findChildren(parentId) {
  if (!isValidId(parentId)) return [];
  return Location.find({ parentId, isActive: true }).sort({ name: 1 });
}
async function findRoots() { return Location.find({ parentId: null, isActive: true }).sort({ name: 1 }); }
async function findByType(type) { return Location.find({ type, isActive: true }).sort({ name: 1 }); }
async function search(query) {
  return Location.find({ $text: { $search: query }, isActive: true }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } }).limit(50);
}
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  const safeFilter = { ...filter };
  if ('parentId' in safeFilter) {
    if (!safeFilter.parentId || safeFilter.parentId === 'null' || safeFilter.parentId === 'undefined') {
      delete safeFilter.parentId;
    } else if (!isValidId(safeFilter.parentId)) {
      return [];
    }
  }
  return Location.find(safeFilter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) {
  const safeFilter = { ...filter };
  if ('parentId' in safeFilter) {
    if (!safeFilter.parentId || safeFilter.parentId === 'null' || safeFilter.parentId === 'undefined') {
      delete safeFilter.parentId;
    } else if (!isValidId(safeFilter.parentId)) {
      return 0;
    }
  }
  return Location.countDocuments(safeFilter);
}
async function findAncestors(id) {
  if (!isValidId(id)) return [];
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
async function findByIds(ids) {
  const safeIds = (ids || []).filter(isValidId);
  if (!safeIds.length) return [];
  return Location.find({ _id: { $in: safeIds } });
}

module.exports = {
  findById, findByName, create, updateFields, deactivate, activate,
  findChildren, findRoots, findByType, search, findAll, count,
  findAncestors, findByIds,
};
