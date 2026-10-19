const paymentService = require('../services/payments.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { isAdmin } = require('../../../shared/utils/roles');

async function createPayment(req, res, next) {
  try {
    const payment = await paymentService.createPayment(req.body, req.user);
    return created(res, { payment, checkoutUrl: payment.checkoutUrl || null, txRef: payment.txRef || null });
  } catch (err) { return next(err); }
}

async function verifyChapaPayment(req, res, next) {
  try { return ok(res, await paymentService.verifyChapaPayment(req.body.orderId, req.body.txRef, req.user)); }
  catch (err) { return next(err); }
}

async function getPayment(req, res, next) {
  try {
    const payment = await paymentService.getPayment(req.params.id);
    return ok(res, { payment });
  } catch (err) { return next(err); }
}

async function getPaymentByOrder(req, res, next) {
  try {
    const payment = await paymentService.getPaymentByOrder(req.params.orderId);
    return ok(res, { payment });
  } catch (err) { return next(err); }
}

async function getUserPayments(req, res, next) {
  try {
    // Identity users carry `id` (UUID); `_id` is the Mongo-style fallback.
    // Guard so one customer cannot list another's payments by swapping :userId.
    const requesterId = String(req.user.id || req.user._id || '');
    const requestedId = String(req.params.userId || '');
    if (!isAdmin(req.user) && requesterId && requestedId && requesterId !== requestedId) {
      return res.status(403).json({ success: false, message: 'Forbidden: you can only access your own payments', errors: [] });
    }
    const payments = await paymentService.getUserPayments(req.params.userId);
    return ok(res, { payments });
  } catch (err) { return next(err); }
}

async function getSellerPayments(req, res, next) {
  try {
    const requesterId = String(req.user.id || req.user._id || '');
    const requestedId = String(req.params.sellerId || '');
    if (!isAdmin(req.user) && requesterId && requestedId && requesterId !== requestedId) {
      return res.status(403).json({ success: false, message: 'Forbidden: you can only access payments for your own sales', errors: [] });
    }
    const payments = await paymentService.getSellerPayments(req.params.sellerId);
    return ok(res, { payments });
  } catch (err) { return next(err); }
}

async function getAllPayments(req, res, next) {
  try {
    const filter = {};
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
    if (req.query.sellerId) filter.sellerId = req.query.sellerId;
    if (req.query.search) filter.$or = [{ orderId: req.query.search }, { transactionId: req.query.search }];
    const payments = await paymentService.getAllPayments(filter);
    return ok(res, { payments, total: payments.length, page: 1, totalPages: 1 });
  } catch (err) { return next(err); }
}

async function listMethods(req, res, next) { try { return ok(res, { methods: await paymentService.listMethods() }); } catch (err) { return next(err); } }
async function listActiveMethods(req, res, next) { try { return ok(res, { methods: await paymentService.listActiveMethods() }); } catch (err) { return next(err); } }
async function saveMethod(req, res, next) { try { return ok(res, { method: await paymentService.saveMethod(req.params.id, req.body) }); } catch (err) { return next(err); } }
async function testConnection(req, res, next) { try { return ok(res, { result: await paymentService.testConnection(req.params.id) }); } catch (err) { return next(err); } }
async function listSellerAccounts(req, res, next) { try { return ok(res, { accounts: await paymentService.listSellerAccounts(isAdmin(req.user) ? undefined : req.user.id) }); } catch (err) { return next(err); } }
async function createSellerAccount(req, res, next) {
  try {
    if (!isAdmin(req.user) && String(req.user.id) !== String(req.params.sellerId)) {
      return res.status(403).json({ success: false, message: 'You can only configure your own payment account', errors: [] });
    }
    return created(res, { account: await paymentService.createSellerAccount(req.params.sellerId, req.body) });
  } catch (err) { return next(err); }
}
async function deleteSellerAccount(req, res, next) {
  try {
    const requesterId = String(req.user.id || req.user._id || '');
    const sellerId = String(req.params.sellerId || requesterId);
    // A seller may only delete their OWN payout account. The row is matched on
    // (id, sellerId) in the service, so this can never reach another seller's
    // account — nor any other record.
    if (!isAdmin(req.user) && requesterId !== sellerId) {
      return res.status(403).json({ success: false, message: 'You can only delete your own payment account', errors: [] });
    }
    const result = await paymentService.deleteSellerAccount(sellerId, req.params.id);
    return ok(res, result, 'Payment account deleted');
  } catch (err) { return next(err); }
}
async function reconciliation(req, res, next) { try { return ok(res, { rows: await paymentService.reconciliation(req.query) }); } catch (err) { return next(err); } }

async function updatePaymentStatus(req, res, next) {
  try {
    const payment = await paymentService.updatePaymentStatus(req.params.id, req.body.status);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PAYMENT_STATUS_CHANGED', level: 'WARNING', adminId, adminName, module: 'commerce', targetEntity: 'payment', targetId: req.params.id, newValue: { status: req.body.status }, ipAddress });
    return ok(res, { payment });
  } catch (err) { return next(err); }
}

async function processRefund(req, res, next) {
  try {
    const payment = await paymentService.processRefund(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PAYMENT_REFUNDED', level: 'CRITICAL', adminId, adminName, module: 'commerce', targetEntity: 'payment', targetId: req.params.id, ipAddress });
    return ok(res, { payment });
  } catch (err) { return next(err); }
}

async function deletePayment(req, res, next) {
  try {
    const result = await paymentService.deletePayment(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'PAYMENT_DELETED', level: 'CRITICAL', adminId, adminName, module: 'commerce', targetEntity: 'payment', targetId: req.params.id, ipAddress });
    return ok(res, result);
  } catch (err) { return next(err); }
}

module.exports = { createPayment, verifyChapaPayment, getPayment, getPaymentByOrder, getUserPayments, getSellerPayments, getAllPayments, updatePaymentStatus, processRefund, deletePayment, listMethods, listActiveMethods, saveMethod, testConnection, listSellerAccounts, createSellerAccount, deleteSellerAccount, reconciliation };
