const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/payments.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { isBuyer, isSeller, isAdmin } = require('../../../shared/utils/roles');

// Ownership guard: non-admins may only touch payments they own (customer for
// user-scoped reads, the selling seller for seller-scoped reads/updates).
// ADMIN bypasses every check.
function requirePaymentOwnership(getPaymentFn) {
  return async (req, res, next) => {
    try {
      if (req.user && isAdmin(req.user.role)) return next();
      const payment = await getPaymentFn(req);
      if (!payment) return res.status(404).json({ success: false, message: 'Payment not found', errors: [] });
      const uid = String(req.user.id);
      if (isBuyer(req.user.role)) {
        if (String(payment.userId) !== uid) {
          return res.status(403).json({ success: false, message: 'Forbidden: you can only access your own payments', errors: [] });
        }
      } else if (isSeller(req.user.role)) {
        if (String(payment.sellerId) !== uid) {
          return res.status(403).json({ success: false, message: 'Forbidden: you can only access payments for your own sales', errors: [] });
        }
      } else {
        return res.status(403).json({ success: false, code: 'ROLE_REQUIRED', message: 'Forbidden', errors: [] });
      }
      req.payment = payment;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const paymentService = require('../services/payments.service');
const ownershipById = requirePaymentOwnership((req) => paymentService.getPayment(req.params.id));
const ownershipByOrder = requirePaymentOwnership((req) => paymentService.getPaymentByOrder(req.params.orderId));

// NOTE: the second argument used to be passed as a separate string, which
// authorize() silently dropped — only SELLER was ever accepted, and ADMIN/BUYER
// were locked out. It is a list now.
router.post('/create-payment', authenticate, authorize(['SELLER', 'BUYER', 'ADMIN']), paymentsController.createPayment);
router.get('/get-payment/:id', authenticate, ownershipById, paymentsController.getPayment);
router.get('/get-payment-by-order/:orderId', authenticate, ownershipByOrder, paymentsController.getPaymentByOrder);
router.get('/get-user-payments/:userId', authenticate, authorize('BUYER', { exact: true }), paymentsController.getUserPayments);
router.get('/get-seller-accounts', authenticate, authorize('SELLER'), paymentsController.listSellerAccounts);
router.get('/get-seller-payments/:sellerId', authenticate, authorize('SELLER'), paymentsController.getSellerPayments);
router.get('/get-all-payments', authenticate, authorize('ADMIN'), paymentsController.getAllPayments);
router.get('/get-active-methods', authenticate, paymentsController.listActiveMethods);
router.get('/admin/methods', authenticate, authorize('ADMIN'), paymentsController.listMethods);
router.post('/admin/methods', authenticate, authorize('ADMIN'), paymentsController.saveMethod);
router.put('/admin/methods/:id', authenticate, authorize('ADMIN'), paymentsController.saveMethod);
router.get('/admin/seller-accounts', authenticate, authorize('ADMIN'), paymentsController.listSellerAccounts);
router.post('/seller/:sellerId/payment-accounts', authenticate, authorize('SELLER', 'ADMIN'), paymentsController.createSellerAccount);
router.get('/admin/reconciliation', authenticate, authorize('ADMIN'), paymentsController.reconciliation);
// Payment status changes require an authoritative provider settlement/refund
// event. No seller or admin-facing route may self-report those outcomes.
router.delete('/delete-payment/:id', authenticate, authorize('ADMIN'), paymentsController.deletePayment);

module.exports = router;
