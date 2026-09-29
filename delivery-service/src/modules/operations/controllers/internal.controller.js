const svc = require('../services/internal.service');
const { ok } = require('../../../shared/utils/response');

async function getOperationsDashboard(_req, res, next) {
  try { return ok(res, { dashboard: await svc.getOperationsDashboard() }); }
  catch (err) { return next(err); }
}

async function listDeliveries(req, res, next) {
  try { return ok(res, await svc.listDeliveries(req.query)); }
  catch (err) { return next(err); }
}

async function getDeliveriesForOrders(req, res, next) {
  try { return ok(res, { deliveries: await svc.getDeliveriesForOrders(req.body.orderIds) }); }
  catch (err) { return next(err); }
}

async function getLocationCounts(_req, res, next) {
  try { return ok(res, { counts: await svc.getLocationCounts() }); }
  catch (err) { return next(err); }
}

module.exports = { getOperationsDashboard, listDeliveries, getDeliveriesForOrders, getLocationCounts };
