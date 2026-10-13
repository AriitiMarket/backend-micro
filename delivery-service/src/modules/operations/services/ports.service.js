const portsRepo = require('../repositories/ports.repository');
const locationsService = require('../../locations-expansion/services/locations.service');

async function createPort(data) {
  if (data.locationId) await locationsService.getLocation(data.locationId);
  return portsRepo.create(data);
}

async function getPort(id) {
  const port = await portsRepo.findById(id);
  if (!port) throw Object.assign(new Error('Port not found'), { status: 404 });
  return port;
}

async function updatePort(id, fields) { await getPort(id); return portsRepo.updateFields(id, fields); }
async function getPorts(filter = {}, options = {}) { return portsRepo.findAll(filter, options); }
async function countPorts(filter = {}) { return portsRepo.count(filter); }
async function getActivePorts() { return portsRepo.findActive(); }
async function getPortsByLocation(locationId) { return portsRepo.findByLocationId(locationId); }

module.exports = {
  createPort, getPort, updatePort, getPorts, countPorts, getActivePorts, getPortsByLocation,
};
