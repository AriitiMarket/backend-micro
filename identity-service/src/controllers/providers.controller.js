// Provider identity controller — only used internally by the Delivery Service.
const providersService = require('../services/providers.service');
const { ok } = require('../utils/response');

async function grantProviderRole(req, res, next) {
  try {
    const result = await providersService.grantProviderRole({ userId: req.body.userId });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function getProviderStatus(req, res, next) {
  try {
    const result = await providersService.getProviderStatus({
      userId: req.body.userId || req.params.id,
    });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/** Suspend / reactivate the provider membership (other actors are unaffected). */
async function setProviderStatus(req, res, next) {
  try {
    const result = await providersService.setProviderStatus({
      userId: req.body.userId,
      status: req.body.status,
    });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { grantProviderRole, getProviderStatus, setProviderStatus };
