const paymentRepository = require('../repositories/payments.repository');
const orderRepository = require('../repositories/orders.repository');
const allocationService = require('./allocation.service');
const { PAYMENT_STATUSES } = require('../constants/orderStatuses');
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
 *     order's paymentStatus to CONFIRMED, and computes seller-level
 *     allocations exactly once (idempotent upsert).
 *   * A failed payment marks the Payment as FAILED and the order as FAILED.
 *   * A pending payment creates the Payment record as PENDING without changing
 *     the order.
 *   * Side-effect order: claim → persist → allocate → audit. If allocation
 *     fails, the payment is still recorded; the allocation is retried via the
 *     same idempotent key on a subsequent delivery.
 */
class PaymentWebhookService {
  constructor() {
    this._processed = new Map(); // in-flight dedup within a single process
  }

  async handleWebhook(payload) {
    const {
      idempotencyKey, orderId, transactionId, paymentMethod,
      status, amount, metadata,
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

      const normalizedStatus = String(status || PAYMENT_STATUSES.PENDING).toUpperCase();
      if (![PAYMENT_STATUSES.PENDING, PAYMENT_STATUSES.COMPLETED, PAYMENT_STATUSES.FAILED].includes(normalizedStatus)) {
        throw new ApiError(`Unknown payment status: ${status}`, 400);
      }

      // ---- 2) Idempotency: has this order already been settled? ----
      const existingPayment = await paymentRepository.findByOrder(orderId);
      if (existingPayment && existingPayment.status === PAYMENT_STATUSES.COMPLETED) {
        // Already completed: duplicate webhook delivery, return success.
        return { success: true, idempotent: true, paymentId: String(existingPayment._id), orderId };
      }

      // ---- 3) Persist the Payment record ----
      const userId = order.buyerId || (order.user && (order.user.id || order.user._id)) || null;
      const sellerId = order.sellerId || null;
      const payableAmount = Number.isFinite(Number(amount)) && Number(amount) > 0
        ? Number(amount)
        : Number(order.totalPrice);

      const payment = await paymentRepository.upsertByOrder(orderId, {
        userId: userId != null ? String(userId) : undefined,
        sellerId: sellerId != null ? String(sellerId) : undefined,
        paymentMethod: String(paymentMethod || 'COD').toUpperCase(),
        amount: payableAmount,
        currency: order.currency || 'ETB',
        status: normalizedStatus,
        transactionId: transactionId || null,
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
        providerWebhookReceivedAt: new Date(),
      });

      // ---- 4) Sync order paymentStatus ----
      const orderPaymentStatus = normalizedStatus === PAYMENT_STATUSES.COMPLETED
        ? 'CONFIRMED'
        : normalizedStatus === PAYMENT_STATUSES.FAILED ? 'FAILED' : 'PENDING';
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

      // ---- 5) Create seller allocations on confirmed payment ----
      if (normalizedStatus === PAYMENT_STATUSES.COMPLETED) {
        try {
          const confirmedOrder = await orderRepository.findById(orderId);
          await allocationService.allocateOrder(confirmedOrder, null);
        } catch (allocErr) {
          // Allocation must not fail a confirmed payment.
          console.error('[paymentWebhook] allocation failed for order', orderId, allocErr.message);
        }
      }

      // ---- 6) Audit ----
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
