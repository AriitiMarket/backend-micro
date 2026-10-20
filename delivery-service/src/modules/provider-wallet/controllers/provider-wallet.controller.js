const svc = require('../services/provider-wallet.service');
const Wallet = require('../models/ProviderWallet');
const providersRepo = require('../../providers/repositories/providers.repository');
const { ok, created } = require('../../../shared/utils/response');
const { isAdmin } = require('../../../shared/utils/access');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

async function getMyWallet(req, res, next) {
  try { return ok(res, await svc.getWallet(req.user.id)); } catch (err) { return next(err); }
}

async function setPayoutAccount(req, res, next) {
  try { return ok(res, { provider: await svc.setPayoutAccount(req.user.id, req.body) }, 'Payout account saved; verification required'); }
  catch (err) { return next(err); }
}

async function requestPayout(req, res, next) {
  try { return created(res, { payout: await svc.requestPayout(req.user.id, req.body.amount) }, 'Payout request submitted'); }
  catch (err) { return next(err); }
}

async function listPayouts(req, res, next) {
  try { return ok(res, { payouts: await svc.listPayouts(req.query.status ? { status: req.query.status } : {}) }); }
  catch (err) { return next(err); }
}

async function approvePayout(req, res, next) { return review(req, res, next, 'approve'); }
async function rejectPayout(req, res, next) { return review(req, res, next, 'reject'); }
async function review(req, res, next, action) {
  try {
    const payout = await svc.reviewPayout(req.params.id, req.user.id, action, req.body.reason, req.body.reference);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: action === 'approve' ? 'DELIVERER_PAYOUT_PAID' : 'DELIVERER_PAYOUT_REJECTED', adminId, adminName, targetEntity: 'provider_payout', targetId: payout._id, newValue: { status: payout.status, amount: payout.amount }, reason: req.body.reason || null, ipAddress });
    return ok(res, { payout }, `Payout ${payout.status}`);
  } catch (err) { return next(err); }
}

async function listWallets(_req, res, next) {
  try {
    const wallets = await Wallet.find({}).populate({ path: 'providerId', select: 'name phone identityUserId metadata' }).sort({ updatedAt: -1 }).limit(500).lean();
    return ok(res, { wallets });
  } catch (err) { return next(err); }
}

async function verifyAccount(req, res, next) {
  try {
    const provider = await providersRepo.findById(req.params.providerId);
    if (!provider?.metadata?.payoutAccount) return res.status(404).json({ success: false, message: 'Payout account not found', errors: [] });
    const updated = await providersRepo.updateFields(provider._id, { 'metadata.payoutAccount.verified': req.body.verified === true });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'DELIVERER_PAYOUT_ACCOUNT_REVIEWED', adminId, adminName, targetEntity: 'provider', targetId: provider._id, newValue: { verified: req.body.verified === true }, reason: req.body.reason || null, ipAddress });
    return ok(res, { provider: updated }, 'Payout account reviewed');
  } catch (err) { return next(err); }
}

module.exports = { getMyWallet, setPayoutAccount, requestPayout, listPayouts, approvePayout, rejectPayout, listWallets, verifyAccount };
