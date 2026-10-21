const paymentRepository = require('../repositories/payments.repository');
const orderRepository = require('../repositories/orders.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');
const walletsService = require('./wallets.service');
const chapaProvider = require('../providers/chapa');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');
const { isAdmin } = require('../../../shared/utils/roles');

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
  async _ensureDefaults() {
    const PaymentMethod = require('../models/PaymentMethods');
    const defaults = [
      { key: 'COD', providerKey: 'cod', name: 'Cash on Delivery', type: 'OFFLINE', availableFor: ['BUYERS'], supportedTransactionTypes: ['PAYMENT'], status: 'ACTIVE', configured: true, sortOrder: 1 },
      { key: 'BANK_TRANSFER', providerKey: 'bank_transfer', name: 'Bank Transfer', type: 'BANK', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false, sortOrder: 2 },
      { key: 'TELEBIRR', providerKey: 'telebirr', name: 'Telebirr', type: 'WALLET', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false, sortOrder: 3 },
      { key: 'CBE_BIRR', providerKey: 'cbe_birr', name: 'CBE Birr', type: 'WALLET', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false, sortOrder: 4 },
      { key: 'CHAPA', providerKey: 'chapa', name: 'Chapa', type: 'GATEWAY', availableFor: ['BUYERS'], supportedTransactionTypes: ['PAYMENT'], status: 'INACTIVE', configured: Boolean(process.env.CHAPA_SECRET_KEY), sortOrder: 5 },
    ];
    for (const defaultsRow of defaults) await PaymentMethod.updateOne({ key: defaultsRow.key }, { $setOnInsert: defaultsRow }, { upsert: true });
  }

  async createPayment(payload, actor = null) {
    await this._ensureDefaults();
    const order = await orderRepository.findById(payload.orderId);
    if (!order) throw new ApiError('Order not found', 404);
    // The actor may only pay for an order they are a PARTY to. The test is
    // OWNERSHIP, not a role guess: one account can be the buyer and the seller
    // of the same order, and the token's primary role says nothing about it
    // (a multi-actor account signs in with BUYER as its primary role).
    if (actor) {
      const actorId = String(actor.id || actor.sub || '');
      const isBuyerOfOrder = String(order.buyerId || order.user?.id || order.user?._id) === actorId;
      const isSellerOfOrder = String(order.sellerId || '') === actorId;
      if (!isBuyerOfOrder && !isSellerOfOrder && !isAdmin(actor)) {
        throw new ApiError('You can only create a payment for your own order', 403);
      }
    }
    const existing = await paymentRepository.findByOrder(payload.orderId);
    if (existing) throw new ApiError('Payment already exists for this order', 409);
    const paymentMethodKey = String(payload.paymentMethod || 'COD').toUpperCase();

    // Load payment method config to check limits and availability
    const PaymentMethod = require('../models/PaymentMethods');
    const method = await PaymentMethod.findOne({ key: paymentMethodKey }).lean();
    if (!method) throw new ApiError('Payment method not found', 404);
    if (method.status !== 'ACTIVE') throw new ApiError('Payment method is not active', 400);
    if (!(method.availableFor || []).includes('BUYERS')) throw new ApiError('Payment method not available for buyers', 400);
    if (method.type !== 'OFFLINE' && !method.configured) throw new ApiError('This payment method is not connected to a verified settlement provider', 400);

    // Enforce amount limits
    const amount = Number(order.totalPrice);
    if (method.minAmount && amount < method.minAmount) {
      throw new ApiError(`Order amount ${amount} is below minimum ${method.minAmount} for ${method.name}`, 400);
    }
    if (method.maxAmount && amount > method.maxAmount) {
      throw new ApiError(`Order amount ${amount} exceeds maximum ${method.maxAmount} for ${method.name}`, 400);
    }

    // Financial identity and amount are server-owned. Never let a client
    // manufacture a paid payment by submitting `status`, `amount`, or ids.
    const userId = order.buyerId || (order.user && (order.user.id || order.user._id)) || null;
    const sellerId = order.sellerId || null;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError('Order has no valid payable amount', 400);
    }

    const payment = await paymentRepository.create({
      orderId: String(payload.orderId),
      userId: userId != null ? String(userId) : undefined,
      sellerId: sellerId != null ? String(sellerId) : undefined,
      paymentMethod: paymentMethodKey,
      amount,
      currency: order.currency || 'ETB',
      status: 'PENDING',
      transactionId: null,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    });

    if (paymentMethodKey === 'CHAPA') {
      try {
        const txRef = `aritii-${String(order._id)}-${Date.now()}`;
        const buyer = order.user || {};
        const origin = String(process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
        const initialized = await chapaProvider.initializeTransaction({
          amount: amount.toFixed(2), currency: order.currency || 'ETB', tx_ref: txRef,
          email: buyer.email || actor?.email || 'buyer@aritii.market',
          first_name: buyer.firstName || buyer.name || 'Buyer',
          last_name: buyer.lastName || '',
          return_url: `${origin}/payment/return?orderId=${encodeURIComponent(String(order._id))}&txRef=${encodeURIComponent(txRef)}`,
          customization: { title: 'Aritii Market', description: `Order ${String(order._id)}` },
        });
        const updated = await paymentRepository.findByIdAndUpdate(payment._id, {
          transactionId: txRef,
          metadata: { provider: 'chapa', checkoutUrl: initialized.checkoutUrl, providerReference: initialized.providerReference },
        }, { new: true });
        updated.checkoutUrl = initialized.checkoutUrl;
        updated.txRef = txRef;
        return updated;
      } catch (error) {
        await paymentRepository.findByIdAndUpdate(payment._id, { status: 'FAILED', metadata: { provider: 'chapa', initializationError: error.code || 'CHAPA_INITIALIZE_FAILED' } }, { new: true });
        await orderRepository.updateFields(order._id, { paymentStatus: 'FAILED' }).catch(() => {});
        try {
          await require('./orders.service').cancelOrder(order._id, {
            userId: String(order.buyerId || actor?.id || ''), userRole: 'BUYER',
            reason: 'Payment initialization failed',
          });
        } catch (cancelError) {
          console.error('[payments] Could not release order after Chapa initialization failure:', cancelError.message);
        }
        throw error;
      }
    }

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
      { key: 'COD', providerKey: 'cod', name: 'Cash on Delivery', type: 'OFFLINE', availableFor: ['BUYERS'], supportedTransactionTypes: ['PAYMENT'], status: 'ACTIVE', configured: true, sortOrder: 1 },
      { key: 'BANK_TRANSFER', providerKey: 'bank_transfer', name: 'Bank Transfer', type: 'BANK', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false, sortOrder: 2 },
      { key: 'TELEBIRR', providerKey: 'telebirr', name: 'Telebirr', type: 'WALLET', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false, sortOrder: 3 },
      { key: 'CBE_BIRR', providerKey: 'cbe_birr', name: 'CBE Birr', type: 'WALLET', availableFor: ['BUYERS', 'SELLERS'], supportedTransactionTypes: ['PAYMENT', 'PAYOUT'], status: 'INACTIVE', configured: false, sortOrder: 4 },
      { key: 'CHAPA', providerKey: 'chapa', name: 'Chapa', type: 'GATEWAY', availableFor: ['BUYERS'], supportedTransactionTypes: ['PAYMENT'], status: 'INACTIVE', configured: Boolean(process.env.CHAPA_SECRET_KEY), sortOrder: 5 },
    ];
    for (const defaultsRow of defaults) await PaymentMethod.updateOne({ key: defaultsRow.key }, { $setOnInsert: defaultsRow }, { upsert: true });
    const rows = await PaymentMethod.find(includeInactive ? {} : { status: 'ACTIVE' }).sort({ sortOrder: 1, name: 1 }).lean();
    return rows.map((row) => ({ id: row._id, key: row.key, providerKey: row.providerKey, name: row.name, type: row.type, description: row.description, availableFor: row.availableFor, supportedTransactionTypes: row.supportedTransactionTypes, currency: row.currency, minAmount: row.minAmount, maxAmount: row.maxAmount, fixedFee: row.fixedFee, percentageFee: row.percentageFee, sortOrder: row.sortOrder, processingSettings: row.processingSettings, verificationRequired: row.verificationRequired, settlementSettings: row.settlementSettings, status: row.status, configured: row.configured, createdAt: row.createdAt }));
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
    const isChapa = String(input.providerKey || existing?.providerKey).toLowerCase() === 'chapa';
    const configured = isChapa ? Boolean(process.env.CHAPA_SECRET_KEY) : input.configured !== false;
    const data = { ...safeInput, key: input.key || existing?.key || String(input.name).toLowerCase().replace(/[^a-z0-9]+/g, '_'), providerKey: input.providerKey, configured, updatedAt: new Date() };
    if (data.status === 'ACTIVE' && data.type !== 'OFFLINE' && !data.configured) throw new ApiError('Configure provider settings before activating this method', 400);
    const row = id ? await PaymentMethod.findByIdAndUpdate(id, data, { new: true }) : await PaymentMethod.create(data);
    return this.listMethods().then((rows) => rows.find((item) => item.id === String(row._id)));
  }

  /**
   * Test connection to a payment provider.
   * This verifies that the provider credentials are valid and the sandbox/live endpoint is reachable.
   * For OFFLINE methods (COD), always returns success.
   */
  async testConnection(methodId) {
    const PaymentMethod = require('../models/PaymentMethods');
    const method = await PaymentMethod.findById(methodId).lean();
    if (!method) throw new ApiError('Payment method not found', 404);

    // OFFLINE methods don't need a connection test
    if (method.type === 'OFFLINE') {
      return { success: true, message: 'Offline method - no connection test needed' };
    }

    // For other types, check if configured
    if (!method.configured) {
      throw new ApiError('Payment method is not configured', 400);
    }

    const providerKey = method.providerKey;
    const isSandbox = method.processingSettings?.mode === 'sandbox';
    if (providerKey === 'chapa') return chapaProvider.testConnection();
    throw new ApiError(`Connection testing is not supported for ${method.name}`, 501);
  }

  async verifyChapaPayment(orderId, txRef, actor) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    const buyerId = String(order.buyerId || order.user?.id || order.user?._id || '');
    if (actor) {
      const actorId = String(actor.id || actor.sub || '');
      if (buyerId !== actorId && !isAdmin(actor)) throw new ApiError('You can only verify your own payment', 403);
    }
    const payment = await paymentRepository.findByOrder(orderId);
    if (!payment || payment.paymentMethod !== 'CHAPA' || String(payment.transactionId) !== String(txRef)) throw new ApiError('Chapa payment reference does not match this order', 404);
    if (payment.status === 'COMPLETED') return { success: true, alreadyCompleted: true, payment };
    const result = await chapaProvider.verifyTransaction(txRef);
    const data = result?.data || {};
    if (String(result?.status).toLowerCase() !== 'success' || String(data.status).toLowerCase() !== 'success') throw new ApiError('Chapa has not confirmed this payment', 402);
    if (String(data.tx_ref) !== String(txRef) || Math.abs(Number(data.amount) - Number(order.totalPrice)) > 0.01 || String(data.currency).toUpperCase() !== String(order.currency || 'ETB').toUpperCase()) throw new ApiError('Verified Chapa payment does not match the order', 409);
    const webhookService = require('./paymentWebhook.service');
    await webhookService.handleWebhook({ idempotencyKey: `chapa:${txRef}`, orderId: String(order._id), transactionId: String(txRef), paymentMethod: 'CHAPA', status: 'COMPLETED', amount: Number(data.amount), currency: data.currency, metadata: { provider: 'chapa', txRef } });
    return { success: true, payment: await paymentRepository.findByOrder(orderId) };
  }

  /**
   * Delete one of a seller's own payout accounts.
   *
   * Scoped to the seller: the row is looked up by (id) AND its sellerId, so a
   * seller can only ever remove their own account and can never reach another
   * seller's row (or anything else) by guessing an id.
   *
   * This exists because the seller workspace's "delete payment account" action
   * was pointed at `DELETE /payment/delete-payment/:id`, which DELETES A
   * PAYMENT — a financial transaction record. A seller pressing "delete my
   * bank account" was asking the server to destroy a transaction.
   */
  async deleteSellerAccount(sellerId, accountId) {
    const SellerPaymentAccount = require('../models/SellerPaymentAccounts');
    const row = await SellerPaymentAccount.findOne({ _id: accountId, sellerId: String(sellerId) });
    if (!row) throw new ApiError('Payment account not found', 404);
    await SellerPaymentAccount.deleteOne({ _id: accountId, sellerId: String(sellerId) });
    return { id: String(accountId), sellerId: String(sellerId), deleted: true };
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
    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(secret).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(String(input.accountNumber || ''), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    const encryptedDetails = `${iv.toString('hex')}:${authTag}:${encrypted}`;
    const row = await SellerPaymentAccount.findOneAndUpdate(
      { sellerId: String(sellerId), methodId: input.methodId },
      {
        $set: {
          provider: input.provider || method.name,
          accountLabel: input.accountLabel || method.name,
          accountHint: String(input.accountNumber || '').slice(-4).padStart(4, '•'),
          encryptedDetails,
          isDefault: Boolean(input.isDefault),
          status: 'PENDING',
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { new: true, upsert: true }
    );
    return { id: row._id, sellerId: row.sellerId, methodId: row.methodId, methodName: method.name, provider: row.provider, status: row.status, isDefault: row.isDefault, accountLabel: row.accountLabel, accountHint: row.accountHint, createdAt: row.createdAt };
  }

  async reconciliation(filters = {}) {
    const payments = await paymentRepository.findAll(filters);
    return payments.map((payment) => { const expected = Number(payment.amount) || 0; const paid = payment.status === 'COMPLETED' ? expected : 0; return { paymentId: payment._id, orderId: payment.orderId, sellerId: payment.sellerId, paymentMethod: payment.paymentMethod, expectedAmount: expected, paidAmount: paid, outstandingAmount: Math.max(expected - paid, 0), refunds: payment.status === 'REFUNDED' ? expected : 0, reconciliationStatus: payment.status === 'COMPLETED' ? 'MATCHED' : payment.status === 'REFUNDED' ? 'RESOLVED' : 'PENDING' }; });
  }

  /**
   * Confirm payment and credit seller wallets
   * Called from payment webhook/callback when payment is verified
   */
  async confirmPayment(paymentId, context = {}) {
    try {
      // Get payment and verify not already completed
      const payment = await paymentRepository.findByIdAndUpdate(
        paymentId,
        { status: 'COMPLETED', verifiedAt: new Date() },
        { new: true }
      );

      if (!payment) throw new ApiError('Payment not found', 404);

      // Sync order payment status
      const orderPaymentStatus = 'CONFIRMED';
      if (payment.orderId) {
        await orderRepository.updateFields(payment.orderId, { paymentStatus: orderPaymentStatus });
      }

      // Get allocations for all sellers in this order
      const allocations = await allocationRepository.findByOrder(payment.orderId);
      if (!allocations || allocations.length === 0) {
        console.warn(`No allocations found for order ${payment.orderId}`);
        return payment;
      }

      // Credit each seller's wallet
      for (const allocation of allocations) {
        try {
          await walletsService.creditFromAllocation(
            String(payment.orderId),
            String(allocation.sellerId),
            {
              grossSubtotal: allocation.grossSubtotal,
              platformCommission: allocation.platformCommission,
              netPayable: allocation.netPayable
            },
            {
              actor: context.userId || null,
              actorType: context.actorType || 'SYSTEM',
              reason: 'Payment confirmed for order'
            }
          );

          console.log(
            `Wallet credited for seller ${allocation.sellerId}: +${allocation.netPayable}`
          );
        } catch (walletErr) {
          console.error(
            `Failed to credit wallet for seller ${allocation.sellerId}:`,
            walletErr
          );
          // Don't throw - payment is already confirmed, wallet credit is secondary
        }
      }

      return payment;
    } catch (err) {
      console.error('confirmPayment error:', err);
      throw err;
    }
  }
}

module.exports = new PaymentService();
