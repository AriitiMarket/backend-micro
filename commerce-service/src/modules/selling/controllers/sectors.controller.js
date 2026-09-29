const sectorsService = require('../services/sectors.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

class SectorsController {
  async create(req, res, next) {
    try {
      const data = await sectorsService.create(req.body);
      const { adminId, adminName, ipAddress } = getAdminFromReq(req);
      sendAudit({ action: 'SECTOR_CREATED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'sector', targetId: data.id || data._id, ipAddress });
      created(res, data);
    } catch (err) { next(err); }
  }

  async getAll(req, res, next) {
    try {
      const data = await sectorsService.getAll(req.query);
      // Admin client reads `res.sectors` (api/admin.ts listSectors); the raw
      // array used to spread into numeric keys and read back as undefined.
      ok(res, { sectors: data });
    } catch (err) { next(err); }
  }

  async getById(req, res, next) {
    try {
      const data = await sectorsService.getById(req.params.id);
      ok(res, data);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      const data = await sectorsService.update(req.params.id, req.body);
      const { adminId, adminName, ipAddress } = getAdminFromReq(req);
      sendAudit({ action: 'SECTOR_UPDATED', level: 'INFO', adminId, adminName, module: 'commerce', targetEntity: 'sector', targetId: req.params.id, ipAddress });
      ok(res, data);
    } catch (err) { next(err); }
  }

  async remove(req, res, next) {
    try {
      const data = await sectorsService.remove(req.params.id);
      const { adminId, adminName, ipAddress } = getAdminFromReq(req);
      sendAudit({ action: 'SECTOR_DELETED', level: 'WARNING', adminId, adminName, module: 'commerce', targetEntity: 'sector', targetId: req.params.id, ipAddress });
      ok(res, data);
    } catch (err) { next(err); }
  }
}

module.exports = new SectorsController();
