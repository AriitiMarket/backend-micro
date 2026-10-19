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
 *   - deliveryFee     (settled separately, never included in seller earnings)
 *
 * NOTE (unresolved business decision): platform settings declare a flat
 * `deliveryFee` (50), while order pricing computes shipping as 3% of the
 * seller's subtotal (`computeShipping`). Allocation uses the server-computed
 * per-order shippingFee (already stored on the order), so reconciliation is
 * consistent with what the buyer actually paid. The deliveryFee vs 3%
 * discrepancy is a configuration decision for the platform team, not something
 * this layer invents. Commission is applied to seller item value only. The
 * delivery fee belongs to delivery settlement and is not seller earnings.
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
function resolveConfiguredRate(settings, sellerId, item, fallbackRate) {
  const sellerRate = settings?.sellerCommissionVariations?.find((variation) =>
    (variation.sellerId && String(variation.sellerId) === String(sellerId)) ||
    (!variation.sellerId && variation.sellerType && variation.sellerType === item?.sellerType)
  )?.commission;
  const legacySellerRate = settings?.sellerCommissionRates?.[sellerId];
  const categoryRate = settings?.categoryCommissions?.find((category) =>
    (category.categoryId && String(category.categoryId) === String(item?.categoryId)) ||
    (category.category && category.category === (item?.categoryName || item?.category))
  )?.commission;
  // Existing sellerCommissionRates is retained for compatibility. Explicit
  // seller rates take priority over category rates, then the platform default.
  if (sellerRate !== undefined && sellerRate !== null && Number.isFinite(Number(sellerRate))) return { rate: Number(sellerRate), source: 'seller' };
  if (legacySellerRate !== undefined && Number.isFinite(Number(legacySellerRate))) return { rate: Number(legacySellerRate), source: 'seller' };
  if (categoryRate !== undefined && categoryRate !== null && Number.isFinite(Number(categoryRate))) return { rate: Number(categoryRate), source: 'category' };
  return { rate: fallbackRate, source: 'default' };
}

function computeOrderAllocations(order, commissionRates = {}, commissionSettings = null) {
  const { taxRate } = _platformPricingSync();
  const allocations = [];
  const shipments = Array.isArray(order.sellerShipments) ? order.sellerShipments : [];
  const orderShipping = Number(order.shippingFee || 0);
  const currency = order.currency || 'ETB';

  for (const shipment of shipments) {
    const sellerId = String(shipment.sellerId || order.sellerId || '');
    const grossSubtotal = _r2(Number(shipment.subtotal || 0));
    const shippingFee = _r2(orderShipping);
    const taxAmount = _r2(grossSubtotal * (taxRate / 100));
    const discountAmount = _r2(Number(shipment.discountAmount ?? order.discountAmount ?? 0));
    const items = Array.isArray(shipment.items) ? shipment.items : [];
    let allocatedDiscount = 0;
    const commissionLines = items.map((item, itemIndex) => {
      const itemGross = _r2(Number(item.subtotal ?? Number(item.price || 0) * Number(item.quantity ?? item.qty ?? 1)));
      const itemDiscount = itemIndex === items.length - 1
        ? _r2(discountAmount - allocatedDiscount)
        : (grossSubtotal > 0 ? _r2(discountAmount * itemGross / grossSubtotal) : 0);
      allocatedDiscount = _r2(allocatedDiscount + itemDiscount);
      const configured = commissionSettings
        ? resolveConfiguredRate(commissionSettings, sellerId, item, commissionRates[sellerId] ?? DEFAULT_COMMISSION_RATE)
        : { rate: commissionRates[sellerId] ?? DEFAULT_COMMISSION_RATE, source: 'default' };
      const rate = configured.rate;
      const commissionBase = Math.max(0, _r2(itemGross - itemDiscount));
      return {
        productId: String(item.productId || item._id || ''),
        categoryId: item.categoryId || null,
        categoryName: item.categoryName || item.category || null,
        grossAmount: itemGross,
        discountAmount: itemDiscount,
        commissionRate: Number(rate),
        commissionSource: configured.source,
        commissionAmount: _r2(commissionBase * Number(rate) / 100),
      };
    });
    if (!commissionLines.length) {
      const configured = commissionSettings
        ? resolveConfiguredRate(commissionSettings, sellerId, {}, commissionRates[sellerId] ?? DEFAULT_COMMISSION_RATE)
        : { rate: commissionRates[sellerId] ?? DEFAULT_COMMISSION_RATE, source: 'default' };
      const rate = configured.rate;
      commissionLines.push({
        productId: '', categoryId: null, categoryName: null,
        grossAmount: grossSubtotal, discountAmount,
        commissionRate: Number(rate), commissionSource: configured.source,
        commissionAmount: _r2(Math.max(0, grossSubtotal - discountAmount) * Number(rate) / 100),
      });
    }
    const commissionBase = Math.max(0, _r2(grossSubtotal - discountAmount));
    const platformCommission = _r2(commissionLines.reduce((sum, line) => sum + line.commissionAmount, 0));
    const commissionRate = commissionBase > 0 ? _r2(platformCommission / commissionBase * 100) : 0;
    const netPayable = _r2(grossSubtotal + taxAmount - discountAmount - platformCommission);

    allocations.push({
      orderId: String(order._id),
      orderGroupId: order.orderGroupId || null,
      sellerId,
      shopId: String(shipment.shopId || ''),
      grossSubtotal,
      shippingFee,
      taxAmount,
      discountAmount,
      platformCommission,
      commissionRate, // snapshot the rate used
      commissionLines,
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
    const sellerId = String(order.sellerId || '');
    const commissionRate = commissionSettings
      ? resolveConfiguredRate(commissionSettings, sellerId, {}, commissionRates[sellerId] ?? DEFAULT_COMMISSION_RATE).rate
      : (commissionRates[sellerId] ?? DEFAULT_COMMISSION_RATE);
    const grossSubtotal = _r2(Number(order.subtotal || 0));
    const shippingFee = _r2(orderShipping);
    const taxAmount = _r2(grossSubtotal * (taxRate / 100));
    const discountAmount = _r2(Number(order.discountAmount || 0));
    const items = Array.isArray(order.cart) ? order.cart : [];
    let allocatedDiscount = 0;
    const commissionLines = items.map((item, itemIndex) => {
      const itemGross = _r2(Number(item.subtotal ?? Number(item.price || item.discountPrice || 0) * Number(item.quantity ?? item.qty ?? 1)));
      const itemDiscount = itemIndex === items.length - 1
        ? _r2(discountAmount - allocatedDiscount)
        : (grossSubtotal > 0 ? _r2(discountAmount * itemGross / grossSubtotal) : 0);
      allocatedDiscount = _r2(allocatedDiscount + itemDiscount);
      const configured = commissionSettings
        ? resolveConfiguredRate(commissionSettings, sellerId, item, commissionRate)
        : { rate: commissionRate, source: 'default' };
      return {
        productId: String(item.productId || item._id || ''),
        categoryId: item.categoryId || null,
        categoryName: item.categoryName || item.category || null,
        grossAmount: itemGross,
        discountAmount: itemDiscount,
        commissionRate: configured.rate,
        commissionSource: configured.source,
        commissionAmount: _r2(Math.max(0, itemGross - itemDiscount) * configured.rate / 100),
      };
    });
    const platformCommission = commissionLines.length
      ? _r2(commissionLines.reduce((sum, line) => sum + line.commissionAmount, 0))
      : _r2(Math.max(0, grossSubtotal - discountAmount) * (commissionRate / 100));
    const commissionBase = Math.max(0, grossSubtotal - discountAmount);
    allocations.push({
      orderId: String(order._id),
      orderGroupId: order.orderGroupId || null,
      sellerId,
      shopId: '',
      grossSubtotal,
      shippingFee,
      taxAmount,
      discountAmount,
      platformCommission,
      commissionRate: commissionBase > 0 ? _r2(platformCommission / commissionBase * 100) : 0,
      commissionLines,
      netPayable: _r2(grossSubtotal + taxAmount - discountAmount - platformCommission),
      refundAmount: 0,
      adjustmentAmount: 0,
      settledAmount: 0,
      pendingAmount: _r2(grossSubtotal + taxAmount - discountAmount - platformCommission),
      currency,
      status: 'PENDING',
      computationSource: 'payment_confirmed',
    });
  }

  return allocations;
}

/**
 * Resolve commission rates for a list of seller IDs.
 * Checks for per-seller overrides first, then falls back to the global rate.
 * @param {string[]} sellerIds
 * @returns {Promise<{rates: Record<string, number>, settings: object|null}>}
 */
async function _resolveCommissionRates(sellerIds) {
  const rates = {};
  const uniqueIds = [...new Set(sellerIds.filter(Boolean))];
  let settings = null;
  try {
    const settingsService = require('../../platform/services/settings.service');
    settings = await settingsService.getPlatformSettings();
  } catch (e) {
    // Settings unavailable: use the platform default for all sellers.
  }
  const { commissionRate: configuredDefault } = await _platformPricing();
  const globalRate = settings && settings.commissionRate !== undefined && settings.commissionRate !== null
    ? Number(settings.commissionRate) : configuredDefault;
  for (const sid of uniqueIds) rates[sid] = globalRate;
  for (const sid of uniqueIds) {
    const legacyRate = settings?.sellerCommissionRates?.[sid];
    if (legacyRate !== undefined && Number.isFinite(Number(legacyRate))) rates[sid] = Number(legacyRate);
  }
  return { rates, settings };
}

/**
 * Persist allocations for an order, idempotently. Each (orderId, sellerId)
 * row is created once; retries preserve the original commission snapshot.
 *
 * Safe to call repeatedly (e.g. duplicate payment webhook deliveries).
 */
async function allocateOrder(order, actor = null) {
  if (!order) throw new ApiError('Order is required to allocate', 400);
  // Resolve per-seller commission rates, then compute allocations synchronously
  const shipmentSellerIds = (Array.isArray(order.sellerShipments) ? order.sellerShipments : [])
    .map(s => String(s.sellerId || order.sellerId || ''))
    .concat(order.sellerId ? [String(order.sellerId)] : [])
    .filter(Boolean);
  const { rates: commissionRates, settings } = await _resolveCommissionRates(shipmentSellerIds);
  const allocations = computeOrderAllocations(order, commissionRates, settings);
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

  // Proportionally reverse platform commission on the refunded amount.
  // Commission was charged on grossSubtotal; refund reverses commission
  // pro-rata on the refunded portion so the platform doesn't keep commission
  // on money being returned to the buyer.
  const previousCommission = Number(allocation.platformCommission || 0);
  // Commission was charged on grossSubtotal at commissionRate%.
  // Reverse commission pro-rata on the refunded amount.
  //
  // A refund that covers the WHOLE net payable returns the whole line, so the
  // commission charged on it goes back with it. The pro-rata rule alone
  // under-reverses in that case, because the refundable amount also contains
  // the shipping that was never commissioned: a full refund of
  // (gross + shipping - commission) reversed only `commission * refund/net`,
  // leaving the platform holding commission on a line that was returned in
  // full — which is exactly what the rule above is meant to prevent.
  const fullyRefunded = newRefund >= previousNet - 0.01;
  const commissionBase = Math.max(0, Number(allocation.grossSubtotal || 0) - Number(allocation.discountAmount || 0));
  const effectiveRate = commissionBase > 0 ? previousCommission / commissionBase : 0;
  const commissionToReverse = fullyRefunded
    ? previousCommission
    : _r2(toRefund * effectiveRate);
  // Cap commission reversal at what's already been charged
  const commissionReversed = Math.min(commissionToReverse, previousCommission);
  const newCommission = _r2(previousCommission - commissionReversed);

  allocation.refundAmount = newRefund;
  allocation.platformCommission = newCommission;
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

