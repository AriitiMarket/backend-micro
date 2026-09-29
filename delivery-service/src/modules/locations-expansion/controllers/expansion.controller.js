const expansionService = require('../services/expansion.service');
const { ok } = require('../../../shared/utils/response');
const { getAdminFromReq } = require('../../../shared/utils/audit-client');

async function getReadiness(req, res, next) {
  try {
    const result = await expansionService.checkReadiness(req.params.id);
    return ok(res, result);
  } catch (err) {
    next(err);
  }
}

async function updateExpansionStatus(req, res, next) {
  try {
    const actor = getAdminFromReq(req);
    const result = await expansionService.changeExpansionStatus(req.params.id, req.body.expansionStatus, actor);
    return ok(res, { location: result }, 'Expansion status updated');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getReadiness,
  updateExpansionStatus
};
