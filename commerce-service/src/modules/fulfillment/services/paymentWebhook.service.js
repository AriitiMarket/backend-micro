const paymentRepository = require('../repositories/payments.repository');
const orderRepository = require('../repositories/orders.repository');
const allocationService = require('./allocation.service');
const walletsService = require('./wallets.service');
const {
  PAYMENT_RECORD_STATUSES,
  PAYMENT_TO_ORDER_STATUS,
} = require('../constants/orderStatuses');
const { sendAudit } = require('../../../shared/utils/audit-client');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/**
 * PAYMENT PROVIDER WEBHOOK SERVICE.
 *
 * Handles asynchronous payment-provider callbacks (e.g. a wallet or bank
 * gateway POSTing a settlement result). Every call is idempotent: the first
 * delivery with a given idempotencyKey performs all side effects; later
 * deliveries of the same key return success without touching any record.
 *
 * Contract:
 *   * `idempotencyKey` is required and must be unique per provider callback.
 *   * A completed payment creates the Payment record exactly once, flips the
 *     order's paymentStatus to CONFIRMED, computes seller-level allocations
 *     exactly once (idempotent upsert) and credits each seller's wallet with
 *     the net payable (pending balance, commission already deducted).
 *   * A failed payment marks the Payment as FAILED and the order as FAILED.
 *   * A pending payment creates the Payment record as PENDING without changing
 *     the order.
 *   * The amount is ALWAYS the trusted order total. A provider that reports a
 *     different amount is a discrepancy, not a price: the callback is rejected
 *     so a tampered or mismatched settlement can never write a payment row.
 *   * Side-effect order: claim -> persist -> allocate -> credit -> audit. If
 *     the allocation or the wallet credit fails, the payment is still
 *     recorded; it is retried via the same idempotency key on a later
 *     delivery.
 */
class PaymentWebhookService {
  constructor() {
    this._processed = new Map(); // in-flight dedup within a single process
  }

  async handleWebhook(payload) {
    const {
      idempotencyKey, orderId, transactionId, paymentMethod,
      status, amount, currency, metadata,
    } = payload || {};

    if (!idempotencyKey || !String(idempotencyKey).trim()) {
      throw new ApiError('idempotencyKey is required', 400);
    }
    if (!orderId) {
      throw new ApiError('orderId is required', 400);
    }

    // In-flight dedup: concurrent deliveries of the same key serialize here.
    const key = String(idempotencyKey);
    if (this._processed.has(key)) {
      return { success: true, idempotent: true, reason: 'in_flight_dedup' };
    }
    this._processed.set(key, true);

    try {
      // ---- 1) Load the order ----
      const order = await orderRepository.findById(orderId);
      if (!order) throw new ApiError('Order not found', 404);

      // The provider speaks the PAYMENT DOCUMENT vocabulary
      // (PENDING | COMPLETED | FAILED). It used to be validated against the
      // ORDER vocabulary (PENDING | CONFIRMED | FAILED), where the value
      // "COMPLETED" does not exist -- so every confirmation was rejected with
      // "Unknown payment status: COMPLETED" and NO PAYMENT COULD EVER BE
      // SETTLED through the platform's only trusted confirmation mechanism.
      // The order-side word for a completed payment is CONFIRMED; the
      // translation lives in PAYMENT_TO_ORDER_STATUS.
      const normalizedStatus = String(status || PAYMENT_RECORD_STATUSES.PENDING).toUpperCase();
      if (![
        PAYMENT_RECORD_STATUSES.PENDING,
        PAYMENT_RECORD_STATUSES.COMPLETED,
        PAYMENT_RECORD_STATUSES.FAILED,
      ].includes(normalizedStatus)) {
        throw new ApiError(`Unknown payment status: ${status}`, 400);
      }

      // ---- 2) Idempotency: has this order already been settled? ----
      const existingPayment = await paymentRepository.findByOrder(orderId);
      if (existingPayment && existingPayment.status === PAYMENT_RECORD_STATUSES.COMPLETED) {
        // Already completed: duplicate webhook delivery, return success.
        return { success: true, idempotent: true, paymentId: String(existingPayment._id), orderId };
      }

      // ---- 3) The payable amount is the TRUSTED order total ----
      // The provider's amount is only used to DETECT a mismatch. Accepting it
      // would let a tampered callback write a payment for a different sum
      // than the buyer actually owed.
      const orderAmount = Number(order.totalPrice);
      if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
        throw new ApiError('Order has no valid payable amount', 400);
      }
      if (amount !== undefined && amount !== null && amount !== '') {
        const reported = Number(amount);
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

      // ---- 4) Persist the Payment record ----
      const userId = order.buyerId || (order.user && (order.user.id || order.user._id)) || null;
      const sellerId = order.sellerId || null;

      const payment = await paymentRepository.upsertByOrder(orderId, {
        userId: userId != null ? String(userId) : undefined,
        sellerId: sellerId != null ? String(sellerId) : undefined,
        paymentMethod: String(paymentMethod || 'COD').toUpperCase(),
        amount: payableAmount,
        currency: orderCurrency,
        status: normalizedStatus,
        transactionId: transactionId || null,
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
        providerWebhookReceivedAt: new Date(),
      });

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
            transactionId: transactionId || (order.paymentInfo?.transactionId || null),
          },
        });
      }

      // ---- 6) Create seller allocations + credit seller wallets ----
      // A confirmed payment must leave the seller with money. The allocation
      // ledger records who is owed what; the wallet credit is what makes it
      // real. Without the credit the seller showed a payable allocation but a
      // zero balance, while the order-CONFIRMED path
      // (orderState.service.js) credited the very same money.
      if (normalizedStatus === PAYMENT_RECORD_STATUSES.COMPLETED) {
        let allocations = [];
        try {
          const confirmedOrder = await orderRepository.findById(orderId);
          allocations = await allocationService.allocateOrder(confirmedOrder, null);
        } catch (allocErr) {
          // Allocation must not fail a confirmed payment.
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
            // A duplicate credit (the same confirmation delivered again) must
            // not fail the callback -- the money is already in the wallet.
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
          newValue: { status: normalizedStatus, orderId, amount: payableAmount, idempotencyKey },
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
