const svc = require('../services/deliveryServices.service');
const providersRepo = require('../../providers/repositories/providers.repository');
const { ok, created } = require('../../../shared/utils/response');
const { badRequest, conflict } = require('../../../shared/errors');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

/**
 * Delivery service catalog — the admin's manage surface.
 *
 *   GET    /delivery/service        paginated catalog (search/status/type)
 *   GET    /delivery/service/:id    one service
 *   POST   /delivery/service        create
 *   PUT    /delivery/service/:id    edit fields / change status
 *   DELETE /delivery/service/:id    delete (blocked while providers use it)
 *
 * Only these fields are writable — everything else on the model is derived.
 */
const WRITABLE_FIELDS = [
  'name', 'code', 'description', 'serviceType', 'status',
  'baseFee', 'perKmFee', 'maxWeightKg', 'estimatedDurationMinutes', 'coverageZones',
];

function pickWritable(body = {}) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

async function getServices(req, res, next) {
  try {
    const { status, serviceType, search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (serviceType) filter.serviceType = serviceType;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { code: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [services, total] = await Promise.all([
      svc.getServices(filter, { skip, limit: safeLimit }),
      svc.countServices(filter),
    ]);
    return ok(res, {
      services,
      count: services.length,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    });
  } catch (err) { return next(err); }
}

async function getService(req, res, next) {
  try { return ok(res, { service: await svc.getService(req.params.id) }); }
  catch (err) { return next(err); }
}

async function createService(req, res, next) {
  try {
    const fields = pickWritable(req.body);
    if (!String(fields.name || '').trim() || !String(fields.code || '').trim()) {
      return next(badRequest('Name and code are required', 'VALIDATION_ERROR'));
    }
    const result = await svc.createService(fields);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'DELIVERY_SERVICE_CREATED', adminId, adminName,
      targetEntity: 'delivery_service', targetId: result._id, newValue: fields, ipAddress,
    });
    return created(res, { service: result }, 'Delivery service created');
  } catch (err) { return next(err); }
}

async function updateService(req, res, next) {
  try {
    const fields = pickWritable(req.body);
    if (Object.keys(fields).length === 0) {
      return next(badRequest('No updatable fields supplied', 'VALIDATION_ERROR'));
    }
    const previous = await svc.getService(req.params.id);
    const result = await svc.updateService(req.params.id, fields);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'DELIVERY_SERVICE_UPDATED', adminId, adminName,
      targetEntity: 'delivery_service', targetId: req.params.id,
      previousValue: previous, newValue: fields, ipAddress,
    });
    return ok(res, { service: result }, 'Delivery service updated');
  } catch (err) { return next(err); }
}

async function deleteService(req, res, next) {
  try {
    const service = await svc.getService(req.params.id);
    const linked = await providersRepo.count({ serviceId: service._id });
    if (linked > 0) {
      return next(conflict(
        `Cannot delete: ${linked} provider${linked === 1 ? '' : 's'} still use this service`,
        'SERVICE_IN_USE'
      ));
    }
    await svc.deleteService(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({
      action: 'DELIVERY_SERVICE_DELETED', level: 'WARNING', adminId, adminName,
      targetEntity: 'delivery_service', targetId: req.params.id,
      previousValue: { id: service._id, name: service.name, code: service.code }, ipAddress,
    });
    return ok(res, { service }, 'Delivery service deleted');
  } catch (err) { return next(err); }
}

module.exports = { getServices, getService, createService, updateService, deleteService };
