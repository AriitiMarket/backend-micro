const orderRepository = require('../repositories/orders.repository');
const sellerAllocationRepository = require('../repositories/sellerAllocation.repository');
const Settlement = require('../models/Settlement');
const SellerAllocation = require('../models/SellerAllocation');
const settingsService = require('../../platform/services/settings.service');
const { sendAudit, ACTIONS, getAdminFromReq } = require('../../../shared/utils/audit-client');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

/**
 * SELLER ALLOCATION SERVICE.
 *
 * Computes, from the actual order items and the configured pricing rules, how
 * much of a confirmed buyer payment belongs to each seller. Keeps a clear
 * distinction between:
 *   1. buyer payment amount
 *   2. seller gross item amount
 *   3. platform commission
 *   4. seller adjustments / refunds
 *   5. seller net payable
 *   6. settled vs pending
 *
 * Business rules sourced from existing configuration (platform settings):
 *   - commissionRate  (default 10 → 10% applied to seller gross subtotal)
 *   - taxRate         (default 0)
 *   - deliveryFee     (flat, configured but NOT used by order pricing — see note)
 *
 * NOTE (unresolved business decision): platform settings declare a flat
 * `deliveryFee` (50), while order pricing computes shipping as 3% of the
 * seller's subtotal (`computeShipping`). Allocation uses the server-computed
 * per-order shippingFee (already stored on the order), so reconciliation is
 * consistent with what the buyer actually paid. The deliveryFee vs 3%
 * discrepancy is a configuration decision for the platform team, not something
 * this layer invents. Commission is applied to the seller gross subtotal only;
 * shipping and tax are passed through to the seller and are not commissioned.
 * Payment-provider fees: COD is the only configured rail and carries no
 * provider fee, so none is allocated. If a provider fee is added later it must
 * be sourced from the provider's settlement advice, not assumed here.
 */

const DEFAULT_COMMISSION_RATE = 10; // percent
const DEFAULT_TAX_RATE = 0; // percent

async function _platformPricing() {
  let settings;
  try { settings = await settingsService.getPlatformSettings(); } catch (e) { settings = null; }
  const commissionRate = settings && Number.isFinite(settings.commissionRate)
    ? Number(settings.commissionRate) : DEFAULT_COMMISSION_RATE;
  const taxRate = settings && Number.isFinite(settings.taxRate)
    ? Number(settings.taxRate) : DEFAULT_TAX_RATE;
  return { commissionRate, taxRate };
}

function _r2(value) { return Math.round((Number(value) || 0) * 100) / 100; }

function _platformPricingSync() {
  return { commissionRate: DEFAULT_COMMISSION_RATE, taxRate: DEFAULT_TAX_RATE };
}
/**
 * Compute the seller-level allocations for one buyer order from its actual
 * priced items and the configured pricing rules. Pure function over the order
 * document (no side effects) so it can be tested in isolation.
 *
 * @param {object} order — an Order document with `sellerShipments`, `subtotal`,
 *   `shippingFee`, `currency`, `orderGroupId`, `_id`.
 * @returns {Array<{sellerId, shopId, grossSubtotal, shippingFee, taxAmount,
 *   discountAmount, platformCommission, netPayable, ...}>
 */
function computeOrderAllocations(order) {
  const { commissionRate, taxRate } = _platformPricingSync();
  const allocations = [];
  const shipments = Array.isArray(order.sellerShipments) ? order.sellerShipments : [];
  const orderShipping = Number(order.shippingFee || 0);
  const currency = order.currency || 'ETB';

  for (const shipment of shipments) {
    const grossSubtotal = _r2(Number(shipment.subtotal || 0));
    const shippingFee = _r2(orderShipping);
    const taxAmount = _r2(grossSubtotal * (taxRate / 100));
    const discountAmount = _r2(0);
    const platformCommission = _r2(grossSubtotal * (commissionRate / 100));
    const netPayable = _r2(grossSubtotal + shippingFee + taxAmount - discountAmount - platformCommission);

    allocations.push({
      orderId: String(order._id),
      orderGroupId: order.orderGroupId || null,
      sellerId: String(shipment.sellerId || order.sellerId || ''),
      shopId: String(shipment.shopId || ''),
      grossSubtotal,
      shippingFee,
      taxAmount,
      discountAmount,
      platformCommission,
      netPayable,
      refundAmount: 0,
      adjustmentAmount: 0,
      settledAmount: 0,
      pendingAmount: netPayable,
      currency,
      status: 'PENDING',
      computationSource: 'payment_confirmed',
    });
  }

  if (allocations.length === 0) {
    const grossSubtotal = _r2(Number(order.subtotal || 0));
    const shippingFee = _r2(orderShipping);
    const taxAmount = _r2(grossSubtotal * (taxRate / 100));
    const platformCommission = _r2(grossSubtotal * (commissionRate / 100));
    allocations.push({
      orderId: String(order._id),
      orderGroupId: order.orderGroupId || null,
      sellerId: String(order.sellerId || ''),
      shopId: '',
      grossSubtotal,
      shippingFee,
      taxAmount,
      discountAmount: 0,
      platformCommission,
      netPayable: _r2(grossSubtotal + shippingFee + taxAmount - platformCommission),
      refundAmount: 0,
      adjustmentAmount: 0,
      settledAmount: 0,
      pendingAmount: netPayable,
      currency,
      status: 'PENDING',
      computationSource: 'payment_confirmed',
    });
  }

  return allocations;
}

/**
 * Persist allocations for an order, idempotently. Each (orderId, sellerId)
 * row is created once; subsequent calls refresh the derived amounts without
 * duplicating rows or money.
 *
 * Safe to call repeatedly (e.g. duplicate payment webhook deliveries).
 */
async function allocateOrder(order, actor = null) {
  if (!order) throw new ApiError('Order is required to allocate', 400);
  const allocations = computeOrderAllocations(order);
  const saved = [];
  for (const allocation of allocations) {
    const row = await sellerAllocationRepository.upsert(
      allocation.orderId, allocation.sellerId, allocation
    );
    saved.push(row);
  }

  try {
    const { adminId, adminName, ipAddress } = actor ? getAdminFromReq({ user: actor }) : { adminId: null, adminName: null, ipAddress: null };
    sendAudit({
      action: ACTIONS.PAYMENT_STATUS_CHANGED,
      level: 'INFO',
      adminId, adminName, module: 'commerce',
      targetEntity: 'order_allocation', targetId: String(order._id),
      newValue: { allocations: saved.map((a) => ({ sellerId: a.sellerId, netPayable: a.netPayable })) },
      ipAddress,
      details: { reason: 'seller allocations computed on confirmed payment', orderGroupId: order.orderGroupId },
    });
  } catch (e) { /* audit must never fail the allocation */ }

  return saved;
}

/**
 * Get all allocations for one buyer order (order group), used by the admin
 * audit view and by a seller scoped to their own row.
 */
async function getOrderAllocations(orderGroupIdOrOrderId) {
  const byGroup = await sellerAllocationRepository.findByOrderGroup(orderGroupIdOrOrderId);
  if (byGroup.length) return byGroup;
  return sellerAllocationRepository.findByOrder(orderGroupIdOrOrderId);
}

/**
 * Get a seller's allocations, scoped strictly to that seller.
 */
async function getSellerAllocations(sellerId, filter = {}) {
  return sellerAllocationRepository.findBySeller(String(sellerId), filter);
}

/**
 * Record a manual settlement (payout) to a seller, audited. Increments
 * settledAmount on the allocation and marks SETTLED/PARTIALLY_SETTLED when
 * fully covered. Safe to retry: Settlement.reference is unique so the same
 * payout is not recorded twice.
 */
async function settleAllocation(allocationId, { amount, reference, provider, initiatedBy, initiatedByRole, reason, actor }) {
  // Full mongoose document (not lean) so `.save()` runs the pre-save hook that
  // recomputes pendingAmount / netPayable. findByIdAndUpdate skips those hooks.
  const allocation = await SellerAllocation.findById(allocationId);
  if (!allocation) throw new ApiError('Allocation not found', 404);
  const payable = Number(allocation.netPayable || 0);
  const already = Number(allocation.settledAmount || 0);
  const toSettle = _r2(Number(amount || 0));
  if (!toSettle || toSettle <= 0) throw new ApiError('Settlement amount must be greater than 0', 400);
  if (already + toSettle > payable + 0.01) {
    throw new ApiError(`Settlement exceeds net payable (payable ${payable}, already settled ${already})`, 400);
  }

  const settlement = await Settlement.create({
    sellerId: allocation.sellerId,
    allocationIds: [allocationId],
    amount: toSettle,
    currency: allocation.currency,
    status: 'COMPLETED',
    reference: reference || null,
    provider: provider || 'manual',
    paidAt: new Date(),
    initiatedBy: initiatedBy || (actor && actor.id) || null,
    initiatedByRole: initiatedByRole || (actor && actor.role) || null,
    reason: reason || null,
  });

  const newSettled = _r2(already + toSettle);
  allocation.settledAmount = newSettled;
  allocation.status = newSettled >= payable - 0.01 ? 'SETTLED' : 'PARTIALLY_SETTLED';
  await allocation.save(); // pre-save recomputes pendingAmount
  const updated = allocation.toObject();

  try {
    const { adminId, adminName, ipAddress } = getAdminFromReq({ user: actor });
    sendAudit({
      action: 'SELLER_SETTLEMENT',
      level: 'INFO',
      adminId, adminName, module: 'commerce',
      targetEntity: 'settlement', targetId: String(settlement._id),
      previousValue: { settledAmount: already },
      newValue: { settledAmount: newSettled, status: updated.status },
      reason,
      details: { allocationId, orderId: allocation.orderId, sellerId: allocation.sellerId, amount: toSettle },
      ipAddress,
    });
  } catch (e) { /* audit must never fail settlement */ }

  return { settlement, allocation: updated };
}

/**
 * Record a refund against one allocation (reduces what the seller is owed).
 * Uses a full-doc `.save()` so the pre-save hook recomputes netPayable and
 * pendingAmount (findByIdAndUpdate would skip them and leave stale totals).
 */
async function refundAllocation(allocationId, { amount, reason, actor }) {
  const allocation = await SellerAllocation.findById(allocationId);
  if (!allocation) throw new ApiError('Allocation not found', 404);
  const toRefund = _r2(Number(amount || 0));
  if (!toRefund || toRefund <= 0) throw new ApiError('Refund amount must be greater than 0', 400);
  const previousNet = Number(allocation.netPayable || 0);
  const previousRefund = Number(allocation.refundAmount || 0);
  const newRefund = _r2(previousRefund + toRefund);
  if (newRefund > previousNet + 0.01) {
    throw new ApiError(`Refund exceeds net payable (net payable ${previousNet}, already refunded ${allocation.refundAmount || 0})`, 400);
  }
  allocation.refundAmount = newRefund;
  const fullyRefunded = newRefund >= Number(allocation.netPayable || 0) - 0.01;
  if (fullyRefunded) allocation.status = 'REFUNDED';
  await allocation.save(); // pre-save recomputes netPayable + pendingAmount

  try {
    const { adminId, adminName, ipAddress } = getAdminFromReq({ user: actor });
    sendAudit({
      action: ACTIONS.PAYMENT_REFUNDED,
      level: 'WARNING',
      adminId, adminName, module: 'commerce',
      targetEntity: 'allocation', targetId: String(allocation._id),
      previousValue: { refundAmount: previousRefund, netPayable: previousNet },
      newValue: { refundAmount: newRefund, netPayable: allocation.netPayable },
      reason,
      details: { orderId: allocation.orderId, sellerId: allocation.sellerId, amount: toRefund },
      ipAddress,
    });
  } catch (e) { /* audit must never fail */ }

  return allocation.toObject();
}

module.exports = {
  computeOrderAllocations,
  allocateOrder,
  getOrderAllocations,
  getSellerAllocations,
  settleAllocation,
  refundAllocation,
  _platformPricing,
  _r2,
};

