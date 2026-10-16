const paymentRepository = require('../repositories/payments.repository');
const orderRepository = require('../repositories/orders.repository');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');
const { isBuyer, isSeller } = require('../../../shared/utils/roles');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/** Payment.status (Payments collection) → Order.paymentStatus vocabulary. */
const PAYMENT_TO_ORDER = {
  PENDING: 'PENDING',
  COMPLETED: 'CONFIRMED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
};

/** Order.paymentStatus → Payment.status vocabulary. */
const ORDER_TO_PAYMENT = {
  PENDING: 'PENDING',
  CONFIRMED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
};

class PaymentService {
  async createPayment(payload, actor = null) {
    const order = await orderRepository.findById(payload.orderId);
    if (!order) throw new ApiError('Order not found', 404);
    if (actor && isBuyer(actor.role) && String(order.buyerId || order.user?.id || order.user?._id) !== String(actor.id)) {
      throw new ApiError('You can only create a payment for your own order', 403);
    }
    if (actor && isSeller(actor.role) && String(order.sellerId) !== String(actor.id)) {
      throw new ApiError('You can only create a payment for your own order', 403);
    }
    const existing = await paymentRepository.findByOrder(payload.orderId);
    if (existing) throw new ApiError('Payment already exists for this order', 409);
    const paymentMethod = String(payload.paymentMethod || 'COD').toUpperCase();
    if (paymentMethod !== 'COD') throw new ApiError('This payment method is not connected to a verified settlement provider', 400);

    // Financial identity and amount are server-owned. Never let a client
    // manufacture a paid payment by submitting `status`, `amount`, or ids.
    const userId = order.buyerId || (order.user && (order.user.id || order.user._id)) || null;
    const sellerId = order.sellerId || null;
    const amount = Number(order.totalPrice);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError('Order has no valid payable amount', 400);
    }

    const payment = await paymentRepository.create({
      orderId: String(payload.orderId),
      userId: userId != null ? String(userId) : undefined,
      sellerId: sellerId != null ? String(sellerId) : undefined,
      paymentMethod,
      amount,
      currency: order.currency || 'ETB',
      status: 'PENDING',
      transactionId: null,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    });

    // Keep the order's payment flag in lock-step with the Payment document so
    // the two collections can never disagree (different vocabularies are
    // mapped explicitly).
    const orderPaymentStatus = PAYMENT_TO_ORDER[payment.status];
    if (orderPaymentStatus && order.paymentStatus !== orderPaymentStatus) {
      await orderRepository.updateFields(order._id, { paymentStatus: orderPaymentStatus });
    }
    return payment;
  }

  getPayment(id) {
    return paymentRepository.findById(id);
  }

  getPaymentByOrder(orderId) {
    return paymentRepository.findByOrder(orderId);
  }

  getUserPayments(userId) {
    return paymentRepository.findByUser(userId);
  }

  getSellerPayments(sellerId) {
    return paymentRepository.findBySeller(sellerId);
  }

  getAllPayments(filters = {}) {
    return paymentRepository.findAll(filters);
  }

  async updatePaymentStatus(id, status) {
    const allowed = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'];
    if (!allowed.includes(status)) {
      throw new ApiError(`Invalid payment status: ${status}`, 400);
    }
    const payment = await paymentRepository.findByIdAndUpdate(id, { status }, { new: true });
    if (!payment) throw new ApiError('Payment not found', 404);
    await this._syncOrderPaymentStatus(payment);
    return payment;
  }

  async processRefund(id) {
    const payment = await paymentRepository.findByIdAndUpdate(id, { status: 'REFUNDED' }, { new: true });
    if (!payment) throw new ApiError('Payment not found', 404);
    await this._syncOrderPaymentStatus(payment);
    return payment;
  }

  /**
   * Mirror a Payment status change onto the parent Order's paymentStatus so
   * the two sources of truth stay consistent (mapped through the vocab pairs).
   */
  async _syncOrderPaymentStatus(payment) {
    if (!payment || !payment.orderId) return;
    const order = await orderRepository.findById(payment.orderId);
    if (!order) return;
    const orderPaymentStatus = PAYMENT_TO_ORDER[payment.status];
    if (orderPaymentStatus && order.paymentStatus !== orderPaymentStatus) {
      await orderRepository.updateFields(order._id, { paymentStatus: orderPaymentStatus });
    }
  }

  async deletePayment(id) {
    const payment = await paymentRepository.findByIdAndDelete(id);
    if (!payment) throw new ApiError('Payment not found', 404);
    return { message: 'Payment deleted successfully!' };
  }

  async listActiveMethods() { return this.listMethods(false); }
  async listMethods(includeInactive = true) {
    const PaymentMethod = require('../models/PaymentMethods');
    const defaults = [
      { key: 'COD', providerKey: 'cod', name: 'Cash on Delivery', type: 'OFFLINE', availableFor: ['BUYERS'], supportedTransactionTypes: ['PAYMENT'], status: 'ACTIVE', configured: true },
      { key: 'BANK_TRANSFER', providerKey: 'bank_transfer', name: 'Bank Transfer', type: 'BANK', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false },
      { key: 'TELEBIRR', providerKey: 'telebirr', name: 'Telebirr', type: 'WALLET', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false },
      { key: 'CBE_BIRR', providerKey: 'cbe_birr', name: 'CBE Birr', type: 'WALLET', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false },
    ];
    for (const defaultsRow of defaults) await PaymentMethod.updateOne({ key: defaultsRow.key }, { $setOnInsert: defaultsRow }, { upsert: true });
    const rows = await PaymentMethod.find(includeInactive ? {} : { status: 'ACTIVE' }).sort({ name: 1 }).lean();
    return rows.map((row) => ({ id: row._id, key: row.key, providerKey: row.providerKey, name: row.name, type: row.type, description: row.description, availableFor: row.availableFor, supportedTransactionTypes: row.supportedTransactionTypes, currency: row.currency, minAmount: row.minAmount, maxAmount: row.maxAmount, fixedFee: row.fixedFee, percentageFee: row.percentageFee, processingSettings: row.processingSettings, verificationRequired: row.verificationRequired, settlementSettings: row.settlementSettings, status: row.status, configured: row.configured, createdAt: row.createdAt }));
  }

  async saveMethod(id, input) {
    const PaymentMethod = require('../models/PaymentMethods');
    if (!input.name || !String(input.name).trim()) throw new ApiError('Payment method name is required', 400);
    if (!input.providerKey || !/^[a-z0-9_]+$/.test(String(input.providerKey))) throw new ApiError('A valid providerKey is required', 400);
    if (input.type && !['OFFLINE', 'BANK', 'WALLET', 'GATEWAY', 'CARD'].includes(input.type)) throw new ApiError('Invalid payment method type', 400);
    if (input.status && !['ACTIVE', 'INACTIVE'].includes(input.status)) throw new ApiError('Invalid payment method status', 400);
    const existing = id ? await PaymentMethod.findById(id).lean() : null;
    if (id && !existing) throw new ApiError('Payment method not found', 404);
    const { providerConfig, ...safeInput } = input;
    const data = { ...safeInput, key: input.key || existing?.key || String(input.name).toLowerCase().replace(/[^a-z0-9]+/g, '_'), providerKey: input.providerKey, configured: input.configured !== false, updatedAt: new Date() };
    if (data.status === 'ACTIVE' && data.type !== 'OFFLINE' && !data.configured) throw new ApiError('Configure provider settings before activating this method', 400);
    const row = id ? await PaymentMethod.findByIdAndUpdate(id, data, { new: true }) : await PaymentMethod.create(data);
    return this.listMethods().then((rows) => rows.find((item) => item.id === String(row._id)));
  }

  async listSellerAccounts(sellerId) {
    const SellerPaymentAccount = require('../models/SellerPaymentAccounts');
    const filter = sellerId ? { sellerId: String(sellerId) } : {};
    const rows = await SellerPaymentAccount.find(filter).populate('methodId', 'name').sort({ createdAt: -1 }).lean();
    return rows.map((row) => ({ id: row._id, sellerId: row.sellerId, methodId: row.methodId?._id || row.methodId, methodName: row.methodId?.name, provider: row.provider, status: row.status, isDefault: row.isDefault, accountLabel: row.accountLabel, accountHint: row.accountHint, createdAt: row.createdAt }));
  }

  async createSellerAccount(sellerId, input) {
    const SellerPaymentAccount = require('../models/SellerPaymentAccounts');
    const PaymentMethod = require('../models/PaymentMethods');
    const method = await PaymentMethod.findById(input.methodId);
    if (!method || method.status !== 'ACTIVE') throw new ApiError('Payment method is not active', 400);
    const crypto = require('crypto');
    const secret = process.env.PAYMENT_ACCOUNT_ENCRYPTION_KEY || process.env.SECRET_KEY || 'development-only-change-me';
    const encryptedDetails = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), crypto.randomBytes(12)).update(String(input.accountNumber || ''), 'utf8').digest('hex');
    const row = await SellerPaymentAccount.create({ sellerId: String(sellerId), methodId: input.methodId, provider: input.provider || method.name, accountLabel: input.accountLabel || method.name, accountHint: String(input.accountNumber || '').slice(-4).padStart(4, '•'), encryptedDetails, isDefault: Boolean(input.isDefault), status: 'PENDING' });
    return { id: row._id, sellerId: row.sellerId, methodId: row.methodId, methodName: method.name, provider: row.provider, status: row.status, isDefault: row.isDefault, accountLabel: row.accountLabel, accountHint: row.accountHint, createdAt: row.createdAt };
  }

  async reconciliation(filters = {}) {
    const payments = await paymentRepository.findAll(filters);
    return payments.map((payment) => { const expected = Number(payment.amount) || 0; const paid = payment.status === 'COMPLETED' ? expected : 0; return { paymentId: payment._id, orderId: payment.orderId, sellerId: payment.sellerId, paymentMethod: payment.paymentMethod, expectedAmount: expected, paidAmount: paid, outstandingAmount: Math.max(expected - paid, 0), refunds: payment.status === 'REFUNDED' ? expected : 0, reconciliationStatus: payment.status === 'COMPLETED' ? 'MATCHED' : payment.status === 'REFUNDED' ? 'RESOLVED' : 'PENDING' }; });
  }
}

module.exports = new PaymentService();
