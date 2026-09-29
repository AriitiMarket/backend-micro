const locationsRepo = require('../repositories/locations.repository');
const { LOCATION_TYPES, ROOT_LOCATION_TYPES, LOCATION_CHILD_TYPES } = require('../../../shared/constants');

function getTypeRules() {
  return { types: LOCATION_TYPES, rootTypes: ROOT_LOCATION_TYPES, children: LOCATION_CHILD_TYPES };
}

function assertChildTypeAllowed(parent, childType) {
  if (!LOCATION_TYPES.includes(childType)) {
    throw Object.assign(new Error(`Invalid location type "${childType}". Allowed: ${LOCATION_TYPES.join(', ')}`), { status: 400 });
  }
  const parentType = parent ? parent.type : null;
  const allowed = LOCATION_CHILD_TYPES[parentType];
  if (!allowed || parentType === 'other') return;
  if (!allowed.includes(childType) && childType !== 'other') {
    throw Object.assign(new Error(`A ${childType} cannot be placed under a ${parentType}. Allowed: ${allowed.join(', ')}`), { status: 400 });
  }
}

async function assertNoCycle(id, newParentId) {
  const selfId = String(id);
  if (selfId === String(newParentId)) {
    throw Object.assign(new Error('A location cannot be its own parent'), { status: 400 });
  }
  const seen = new Set([String(newParentId)]);
  let current = await locationsRepo.findById(newParentId);
  while (current && current.parentId) {
    const key = String(current.parentId);
    if (key === selfId) {
      throw Object.assign(new Error('A location cannot be moved under its own descendant'), { status: 400 });
    }
    if (seen.has(key)) break;
    seen.add(key);
    current = await locationsRepo.findById(key);
  }
}

async function createLocation(data) {
  if (data.parentId === '' || data.parentId === undefined) data.parentId = null;
  if (!data.parentId && !ROOT_LOCATION_TYPES.includes(data.type)) {
    throw Object.assign(new Error(`A ${data.type} cannot start a hierarchy. Root types: ${ROOT_LOCATION_TYPES.join(', ')}`), { status: 400 });
  }
  if (data.parentId) {
    const parent = await locationsRepo.findById(data.parentId);
    if (!parent) throw Object.assign(new Error('Parent location not found'), { status: 404 });
    if (!parent.isActive) throw Object.assign(new Error('Parent location is inactive'), { status: 400 });
    assertChildTypeAllowed(parent, data.type);
  }
  return locationsRepo.create(data);
}

async function getLocation(id) {
  const loc = await locationsRepo.findById(id);
  if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });
  return loc;
}

const UPDATABLE_FIELDS = ['name', 'code', 'description', 'metadata'];

async function updateLocation(id, fields = {}) {
  const loc = await locationsRepo.findById(id);
  if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });

  const patch = {};
  for (const key of UPDATABLE_FIELDS) {
    if (fields[key] !== undefined) patch[key] = fields[key];
  }

  let nextParent = null;
  if (fields.parentId !== undefined) {
    nextParent = fields.parentId === '' || fields.parentId === null ? null : String(fields.parentId);
    if (nextParent) {
      const parent = await locationsRepo.findById(nextParent);
      if (!parent) throw Object.assign(new Error('Parent location not found'), { status: 404 });
      if (!parent.isActive) throw Object.assign(new Error('Parent location is inactive'), { status: 400 });
      await assertNoCycle(id, nextParent);
      assertChildTypeAllowed(parent, fields.type || loc.type);
    } else if (fields.type === undefined) {
      assertChildTypeAllowed(null, loc.type);
    }
    patch.parentId = nextParent;
  }

  if (fields.type !== undefined) {
    const parentId = fields.parentId !== undefined ? nextParent : loc.parentId;
    if (parentId) {
      const parent = await locationsRepo.findById(parentId);
      if (parent) assertChildTypeAllowed(parent, fields.type);
    } else {
      assertChildTypeAllowed(null, fields.type);
    }
    patch.type = fields.type;
  }

  if (fields.isActive !== undefined) {
    if (fields.isActive) {
      patch.isActive = true;
    } else {
      const children = await locationsRepo.findChildren(id);
      if (children.length > 0) {
        throw Object.assign(new Error('Cannot deactivate location with active children'), { status: 400 });
      }
      patch.isActive = false;
    }
  }

  if (Object.keys(patch).length === 0) return loc;
  return locationsRepo.updateFields(id, patch);
}

async function deactivateLocation(id) {
  const loc = await locationsRepo.findById(id);
  if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });
  const children = await locationsRepo.findChildren(id);
  if (children.length > 0) throw Object.assign(new Error('Cannot deactivate location with active children'), { status: 400 });
  return locationsRepo.deactivate(id);
}

async function activateLocation(id) {
  const loc = await locationsRepo.findById(id);
  if (!loc) throw Object.assign(new Error('Location not found'), { status: 404 });
  return locationsRepo.activate(id);
}

async function getChildren(id) { await getLocation(id); return locationsRepo.findChildren(id); }
async function getRoots() { return locationsRepo.findRoots(); }
async function getLocations(filter = {}, options = {}) {
  return locationsRepo.findAll(filter, options);
}
async function countLocations(filter = {}) { return locationsRepo.count(filter); }
async function getLocationStats() {
  const [totalLocations, activeLocations, serviceableLocations, hubs, pendingExpansion] = await Promise.all([
    locationsRepo.count({}),
    locationsRepo.count({ isActive: true }),
    locationsRepo.count({ 'serviceability.serviceable': true }),
    locationsRepo.count({ 'hub.isHub': true }),
    locationsRepo.count({ expansionStatus: { $in: ['planned', 'preparing'] } }),
  ]);
  return { totalLocations, activeLocations, serviceableLocations, hubs, pendingExpansion };
}
async function searchLocations(q) { return locationsRepo.search(q); }
async function getAncestors(id) { await getLocation(id); return locationsRepo.findAncestors(id); }
async function getLocationsByType(type) { return locationsRepo.findByType(type); }

async function getHierarchy() {
  const roots = await locationsRepo.findRoots();
  const visited = new Set();

  async function buildTree(parentId) {
    const children = await locationsRepo.findChildren(parentId);
    const nodes = [];
    for (const child of children) {
      const key = String(child._id);
      if (visited.has(key)) continue;
      visited.add(key);
      nodes.push({
        _id: child._id, name: child.name, type: child.type, code: child.code,
        isActive: child.isActive, parentId: child.parentId,
        children: await buildTree(child._id),
      });
    }
    return nodes;
  }

  const tree = [];
  for (const root of roots) {
    const key = String(root._id);
    if (visited.has(key)) continue;
    visited.add(key);
    tree.push({
      _id: root._id, name: root.name, type: root.type, code: root.code,
      isActive: root.isActive, parentId: root.parentId,
      children: await buildTree(root._id),
    });
  }
  return tree;
}

const MAX_BULK_ROWS = 500;

async function bulkCreateLocations(rows) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('rows must be an array'), { status: 400 });
  if (rows.length === 0) throw Object.assign(new Error('No rows to import'), { status: 400 });
  if (rows.length > MAX_BULK_ROWS) {
    throw Object.assign(new Error(`Too many rows: ${rows.length}. Limit is ${MAX_BULK_ROWS}.`), { status: 400 });
  }

  const createdByName = new Map();
  const created = [];
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const label = String(row.name || '').trim();
    try {
      if (!label) throw Object.assign(new Error('name is required'), { status: 400 });
      const type = String(row.type || '').trim().toLowerCase();
      if (!type) throw Object.assign(new Error('type is required'), { status: 400 });
      if (!LOCATION_TYPES.includes(type)) {
        throw Object.assign(new Error(`invalid type "${row.type}". Allowed: ${LOCATION_TYPES.join(', ')}`), { status: 400 });
      }
      const parentName = String(row.parentName || '').trim();
      let parentId = null;
      if (parentName) {
        const fromBatch = createdByName.get(parentName.toLowerCase());
        if (fromBatch) {
          parentId = fromBatch;
        } else {
          const existing = await locationsRepo.findByName(parentName, null);
          if (!existing) throw Object.assign(new Error(`parent "${parentName}" not found`), { status: 400 });
          parentId = existing._id;
        }
      }
      const duplicate = await locationsRepo.findByName(label, parentId);
      if (duplicate) {
        failed.push({ row: i + 1, name: label, reason: 'already exists' });
        createdByName.set(label.toLowerCase(), duplicate._id);
        continue;
      }
      const location = await createLocation({
        name: label, type, parentId,
        code: row.code ? String(row.code).trim() : null,
        description: row.description ? String(row.description).trim() : '',
        isActive: row.isActive === undefined ? true : Boolean(row.isActive),
      });
      created.push(location);
      createdByName.set(label.toLowerCase(), location._id);
    } catch (err) {
      failed.push({ row: i + 1, name: label || null, reason: err.message });
    }
  }
  return { created, createdCount: created.length, failed, failedCount: failed.length, total: rows.length, limit: MAX_BULK_ROWS };
}

module.exports = {
  createLocation, getLocation, updateLocation, deactivateLocation, activateLocation,
  getChildren, getRoots, getLocations, countLocations, getLocationStats, searchLocations, getAncestors,
  getLocationsByType, getHierarchy, bulkCreateLocations, getTypeRules,
};
