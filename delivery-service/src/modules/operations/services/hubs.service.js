const hubsRepo = require('../repositories/hubs.repository');
const locationsService = require('../../locations-expansion/services/locations.service');

async function createHub(data) {
  if (data.locationId) await locationsService.getLocation(data.locationId);
  return hubsRepo.create(data);
}

async function getHub(id) {
  const hub = await hubsRepo.findById(id);
  if (!hub) throw Object.assign(new Error('Hub not found'), { status: 404 });
  return hub;
}

async function updateHub(id, fields) { await getHub(id); return hubsRepo.updateFields(id, fields); }
async function getHubs(filter = {}, options = {}) { return hubsRepo.findAll(filter, options); }
async function countHubs(filter = {}) { return hubsRepo.count(filter); }
async function getActiveHubs() { return hubsRepo.findActive(); }
async function getHubsByLocation(locationId) { return hubsRepo.findByLocationId(locationId); }

module.exports = {
  createHub, getHub, updateHub, getHubs, countHubs, getActiveHubs, getHubsByLocation,
};
