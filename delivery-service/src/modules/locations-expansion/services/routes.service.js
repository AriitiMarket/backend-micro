const routesRepo = require('../repositories/routes.repository');
const locationsService = require('./locations.service');

async function createRoute(data) {
  const origin = await locationsService.getLocation(data.originLocationId);
  const dest = await locationsService.getLocation(data.destinationLocationId);
  if (!origin.isActive || !dest.isActive) {
    throw Object.assign(new Error('Origin or destination location is inactive'), { status: 400 });
  }
  const existing = await routesRepo.findAnyByEndpoints(data.originLocationId, data.destinationLocationId);
  if (existing) {
    throw Object.assign(
      new Error(`A connection between these locations already exists (status: ${existing.status}). Reactivate it instead.`),
      { status: 409, existingRouteId: String(existing._id) },
    );
  }
  return routesRepo.create(data);
}

async function getRoute(id) {
  const route = await routesRepo.findById(id);
  if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
  return route;
}

async function updateRoute(id, fields) { 
  await getRoute(id); 
  return routesRepo.updateFields(id, fields); 
}

async function deleteRoute(id) {
  await getRoute(id);
  return routesRepo.deleteRoute(id);
}

async function getRoutes(filter = {}, options = {}) { return routesRepo.findAll(filter, options); }
async function countRoutes(filter = {}) { return routesRepo.count(filter); }
async function getActiveRoutes() { return routesRepo.findActive(); }
async function findRouteByEndpoints(originId, destId) { return routesRepo.findByEndpoints(originId, destId); }
async function getRoutesFromOrigin(originLocationId) { return routesRepo.findByOrigin(originLocationId); }
async function getRoutesToDestination(destLocationId) { return routesRepo.findByDestination(destLocationId); }

async function getRouteStats() {
  const allRoutes = await routesRepo.findAll({});
  const activeRoutes = allRoutes.filter(r => r.status === 'active');
  const inOperationRoutes = allRoutes.filter(r => r.status === 'active' && r.providerId);
  const delayedRoutes = allRoutes.filter(r => r.status === 'suspended');
  const reviewRequiredRoutes = allRoutes.filter(r => r.status === 'inactive');
  
  return {
    totalRoutes: allRoutes.length,
    activeRoutes: activeRoutes.length,
    routesInOperation: inOperationRoutes.length,
    delayedRoutes: delayedRoutes.length,
    routesRequiringReview: reviewRequiredRoutes.length,
  };
}

module.exports = {
  createRoute, getRoute, updateRoute, deleteRoute, getRoutes, countRoutes, getActiveRoutes, getRouteStats,
  findRouteByEndpoints, getRoutesFromOrigin, getRoutesToDestination,
};
