const svc = require('../services/operations.service');
const { isSeller } = require('../../../shared/utils/access');
const { ok } = require('../../../shared/utils/response');

async function getDashboard(req, res, next) {
  try {
    // A seller only ever sees their own operation — never platform totals.
    const scope = req.user && isSeller(req.user) ? { sellerId: req.user.id } : {};
    const { zoneId, serviceId, providerId, status, dateFrom, dateTo } = req.query;
    // Legacy spelling of the provider filter, still sent by deployed clients.
    const requestedProviderId = providerId || req.query.partnerId;
    const dashboard = await svc.getDashboard(
      { zoneId, serviceId, providerId: requestedProviderId, status, dateFrom, dateTo }, scope
    );
    return ok(res, { dashboard });
  }
  catch (err) { return next(err); }
}

async function getDeliveryStats(_req, res, next) {
  try { return ok(res, { stats: await svc.getDeliveryStatsByStatus() }); }
  catch (err) { return next(err); }
}

async function getRecentDeliveries(req, res, next) {
  try { const d = await svc.getRecentDeliveries(parseInt(req.query.limit) || 20); return ok(res, { deliveries: d, count: d.length }); }
  catch (err) { return next(err); }
}

async function getExpansionStatus(req, res, next) {
  try { return ok(res, { expansion: await svc.getExpansionStatus(req.params.locationId) }); }
  catch (err) { return next(err); }
}

async function bulkActivate(req, res, next) {
  try { return ok(res, { activated: await svc.bulkActivate(req.params.locationId) }, 'Location bulk activated'); }
  catch (err) { return next(err); }
}

async function bulkDeactivate(req, res, next) {
  try { return ok(res, { deactivated: await svc.bulkDeactivate(req.params.locationId) }, 'Location bulk deactivated'); }
  catch (err) { return next(err); }
}

module.exports = { getDashboard, getDeliveryStats, getRecentDeliveries, getExpansionStatus, bulkActivate, bulkDeactivate };
