const paymentRepository = require('../repositories/payments.repository');
const orderRepository = require('../../orders/repositories/orders.repository');
const allocationService = require('../../orders/services/allocation.service');
const walletsService = require('./wallets.service');
const paymentLedgerService = require('./paymentLedger.service');
const PaymentLedger = require('../models/PaymentLedger');
const {
  PAYMENT_RECORD_STATUSES,
  PAYMENT_TO_ORDER_STATUS,
} = require('../../orders/constants/orderStatuses');
const { sendAudit } = require('../../../shared/utils/audit-client');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/**
 * PAYMENT PROVIDER WEBHOOK SERVICE.
 *
 * Handles asynchronous payment-provider callbacks (e.g. Chapa, wallet or bank
 * gateway POSTing a settlement result). Every call is idempotent: the first
 * delivery with a given idempotencyKey / tx_ref performs all side effects; later
 * deliveries of the same key return success without touching any record.
 */
class PaymentWebhookService {
  constructor() {
    this._processed = new Map(); // in-flight dedup within a single process
  }

  async handleWebhook(payload) {
    const {
      idempotencyKey, orderId: rawOrderId, transactionId: rawTxId, paymentMethod,
      status: rawStatus, amount: rawAmount, currency, metadata,
      tx_ref, txRef, eventId, reference, event,
    } = payload || {};

    const key = String(
      idempotencyKey || eventId || tx_ref || txRef || reference || rawTxId || ''
    ).trim();

    if (!key) {
      throw new ApiError('idempotencyKey is required', 400);
    }

    // Resolve orderId if not explicitly provided
    const effectiveTxRef = tx_ref || txRef || reference || rawTxId || null;
    let orderId = rawOrderId;
    if (!orderId && effectiveTxRef) {
      const existingByTx = await paymentRepository.findOne({ transactionId: effectiveTxRef });
      if (existingByTx) {
        orderId = existingByTx.orderId;
      } else {
        const match = String(effectiveTxRef).match(/^aritii-([a-f0-9]{24})/i);
        if (match) orderId = match[1];
      }
    }
    if (!orderId && metadata && typeof metadata === 'object' && metadata.orderId) {
      orderId = metadata.orderId;
    }
    if (!orderId) {
      throw new ApiError('orderId is required', 400);
    }

    // In-flight dedup: concurrent deliveries of the same key serialize here.
    if (this._processed.has(key)) {
      return { success: true, idempotent: true, reason: 'in_flight_dedup' };
    }
    this._processed.set(key, true);

    try {
      // Normalize status (supports both Chapa 'success' / 'failed' and platform 'COMPLETED' / 'FAILED' / 'PENDING')
      let normalizedStatus = String(rawStatus || PAYMENT_RECORD_STATUSES.PENDING).toUpperCase();
      if (normalizedStatus === 'SUCCESS' || normalizedStatus === 'SUCCESSFUL') {
        normalizedStatus = PAYMENT_RECORD_STATUSES.COMPLETED;
      }
      if (![
        PAYMENT_RECORD_STATUSES.PENDING,
        PAYMENT_RECORD_STATUSES.COMPLETED,
        PAYMENT_RECORD_STATUSES.FAILED,
      ].includes(normalizedStatus)) {
        throw new ApiError(`Unknown payment status: ${rawStatus}`, 400);
      }

      // Check if already processed (Idempotency)
      const existingPayment = await paymentRepository.findByOrder(orderId);
      const existingByTx = effectiveTxRef ? await paymentRepository.findOne({ transactionId: effectiveTxRef }) : null;
      const activePayment = existingPayment || existingByTx;

      let alreadyLogged = false;
      const ledgerQueries = [];
      if (effectiveTxRef) ledgerQueries.push({ transactionId: effectiveTxRef });
      if (key) ledgerQueries.push({ 'providerResponse.idempotencyKey': key });
      if (ledgerQueries.length > 0) {
        const existingEntry = await PaymentLedger.findOne({ $or: ledgerQueries });
        if (existingEntry) alreadyLogged = true;
      }

      if ((activePayment && activePayment.status === PAYMENT_RECORD_STATUSES.COMPLETED) || alreadyLogged) {
        return {
          success: true,
          idempotent: true,
          paymentId: String(activePayment?._id || ''),
          orderId: String(orderId),
          status: activePayment?.status || normalizedStatus,
        };
      }

      // ---- 1) Load the order ----
      const order = await orderRepository.findById(orderId);
      if (!order) throw new ApiError('Order not found', 404);

      // ---- 2) The payable amount is the TRUSTED order total ----
      const orderAmount = Number(order.totalPrice);
      if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
        throw new ApiError('Order has no valid payable amount', 400);
      }
      if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
        const reported = Number(rawAmount);
        if (!Number.isFinite(reported) || reported <= 0) {
          throw new ApiError('Provider reported an invalid amount', 400);
        }
        if (Math.abs(reported - orderAmount) > 0.01) {
          throw new ApiError(
            `Provider amount ${reported} does not match the order amount ${orderAmount}`,
            409,
          );
        }
      }
      const orderCurrency = order.currency || 'ETB';
      if (currency && String(currency).toUpperCase() !== String(orderCurrency).toUpperCase()) {
        throw new ApiError(
          `Provider currency ${currency} does not match the order currency ${orderCurrency}`,
          409,
        );
      }
      const payableAmount = orderAmount;

      // ---- 3) Persist the Payment record ----
      const userId = order.buyerId || (order.user && (order.user.id || order.user._id)) || null;
      const sellerId = order.sellerId || null;

      const previousStatus = activePayment ? activePayment.status : 'NONE';
      const payment = await paymentRepository.upsertByOrder(orderId, {
        userId: userId != null ? String(userId) : undefined,
        sellerId: sellerId != null ? String(sellerId) : undefined,
        paymentMethod: String(paymentMethod || 'COD').toUpperCase(),
        amount: payableAmount,
        currency: orderCurrency,
        status: normalizedStatus,
        transactionId: effectiveTxRef || null,
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
        providerWebhookReceivedAt: new Date(),
      });

      // ---- 4) Record in PaymentLedger (audit trail) ----
      try {
        await paymentLedgerService.logPaymentChange(
          payment._id || payment.id,
          previousStatus,
          normalizedStatus,
          {
            userId: userId != null ? String(userId) : undefined,
            actor: 'PROVIDER',
            actorType: 'PROVIDER',
            reason: 'PAYMENT_WEBHOOK',
            transactionId: effectiveTxRef || null,
            providerResponse: { idempotencyKey: key, ...(metadata || {}) },
          }
        );
      } catch (ledgerErr) {
        console.error('[paymentWebhook] logging to PaymentLedger failed:', ledgerErr.message);
      }

      // ---- 5) Sync order paymentStatus ----
      const orderPaymentStatus = PAYMENT_TO_ORDER_STATUS[normalizedStatus];
      if (order.paymentStatus !== orderPaymentStatus) {
        await orderRepository.updateFields(order._id, {
          paymentStatus: orderPaymentStatus,
          ...(orderPaymentStatus === 'CONFIRMED' ? { paidAt: order.paidAt || new Date() } : {}),
          paymentInfo: {
            ...(order.paymentInfo || {}),
            status: orderPaymentStatus,
            method: String(paymentMethod || order.paymentInfo?.method || 'COD').toUpperCase(),
            transactionId: effectiveTxRef || (order.paymentInfo?.transactionId || null),
          },
        });
      }

      // ---- 6) Create seller allocations + credit seller wallets ----
      if (normalizedStatus === PAYMENT_RECORD_STATUSES.COMPLETED) {
        let allocations = [];
        try {
          const confirmedOrder = await orderRepository.findById(orderId);
          allocations = await allocationService.allocateOrder(confirmedOrder, null);
        } catch (allocErr) {
          console.error('[paymentWebhook] allocation failed for order', orderId, allocErr.message);
        }

        for (const alloc of allocations) {
          try {
            await walletsService.creditFromAllocation(
              String(orderId),
              String(alloc.sellerId),
              {
                grossSubtotal: alloc.grossSubtotal,
                shippingFee: alloc.shippingFee,
                taxAmount: alloc.taxAmount,
                discountAmount: alloc.discountAmount,
                platformCommission: alloc.platformCommission,
                commissionRate: alloc.commissionRate,
                netPayable: alloc.netPayable,
                allocationId: String(alloc._id),
                reason: 'PAYMENT_CONFIRMED',
                metadata: { orderGroupId: alloc.orderGroupId, shopId: alloc.shopId },
              },
              { actor: null, actorType: 'SYSTEM' },
            );
          } catch (walletErr) {
            if (walletErr && walletErr.statusCode === 409) continue;
            console.error(
              `[paymentWebhook] wallet credit failed for seller ${alloc.sellerId}:`,
              walletErr.message,
            );
          }
        }
      }

      // ---- 7) Audit ----
      try {
        sendAudit({
          action: 'PAYMENT_WEBHOOK_RECEIVED',
          level: 'INFO',
          module: 'commerce',
          targetEntity: 'payment', targetId: String(payment._id || payment.id),
          newValue: { status: normalizedStatus, orderId, amount: payableAmount, idempotencyKey: key },
          details: { providerWebhook: true, idempotent: false },
        });
      } catch (e) { /* audit must never fail the webhook */ }

      return { success: true, idempotent: false, paymentId: String(payment._id || payment.id), orderId, status: normalizedStatus };
    } finally {
      this._processed.delete(key);
    }
  }
}

module.exports = new PaymentWebhookService();
