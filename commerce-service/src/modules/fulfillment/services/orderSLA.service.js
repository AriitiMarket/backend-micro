const mongoose = require('mongoose');
const orderSLARepository = require('../repositories/orderSLA.repository');
const orderRepository = require('../repositories/orders.repository');
const { isAdmin } = require('../../../shared/utils/roles');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** How far back each dashboard period reaches. */
const PERIOD_DAYS = {
  day: 1,
  week: 7,
  month: 30,
};

class OrderSLAService {
  async setSLA(orderId, stateName, durationHours, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        throw new ApiError('Order not found', 404);
      }

      this.assertOrderAccess(order, context.actor, 'set an SLA on');

      const hours = Number(durationHours);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new ApiError('durationHours must be a positive number', 400);
      }

      const deadline = new Date();
      deadline.setHours(deadline.getHours() + hours);

      const sla = await orderSLARepository.create(
        {
          orderId: String(orderId),
          stateName,
          durationHours: hours,
          deadline,
          setBy: context.userId,
          breached: false,
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return sla;
    } catch (err) {
      if (session?.inTransaction && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * PUSH IN a breach against an order.
   *
   * Until now a breach could only ever be DERIVED (the deadline passed). This
   * records one explicitly: an operations admin upholds a dispute, or a
   * deadline was mis-declared, and the order must show up on the SLA
   * dashboard even though its recorded deadline is still in the future.
   *
   * The breach lands on the order's EXISTING SLA record when there is one —
   * the same row the dashboard reads — so the order ends up with a single,
   * coherent SLA story instead of two competing records.
   */
  async createBreach(orderId, payload = {}, context = {}) {
    const reason = String(payload.reason || '').trim();
    if (!reason) {
      throw new ApiError('A reason is required to record a breach', 400);
    }

    // Recording a breach is an ADMIN judgement — an upheld dispute, a
    // mis-declared deadline. It is enforced here as well as on the route, so
    // an internal caller cannot push a breach in either: a seller must not be
    // able to mark their OWN order as breached.
    if (!isAdmin(context.actor)) {
      throw new ApiError('Only an administrator can record a breach', 403);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        throw new ApiError('Order not found', 404);
      }

      this.assertOrderAccess(order, context.actor, 'record a breach on');

      const now = new Date();
      const existing = await orderSLARepository.findByOrderId(orderId);

      if (existing) {
        // The FIRST breach time wins: an auto-detected breach already carries
        // the moment the deadline passed, and pushing one in afterwards must
        // not move it forward. The SOURCE, however, becomes MANUAL — the
        // recorded reason came from a human, so the audit trail has to say so
        // even when the deadline itself had already passed.
        const breachedAt = existing.breachedAt || now;

        const updated = await orderSLARepository.update(
          existing._id,
          {
            breached: true,
            breachedAt,
            breachReason: reason,
            breachedBy: context.userId || null,
            breachSource: 'MANUAL',
          },
          { session }
        );

        await session.commitTransaction();
        return updated;
      }

      // No SLA was ever set for this order: record the breach as its own SLA
      // row so the dashboard can show it. The deadline defaults to NOW (the
      // service level was missed) and is already in the past.
      const deadline = payload.deadline ? new Date(payload.deadline) : now;
      if (Number.isNaN(deadline.getTime())) {
        throw new ApiError('deadline is not a valid date', 400);
      }

      const durationHours = Number(payload.durationHours);
      const sla = await orderSLARepository.create(
        {
          orderId: String(orderId),
          stateName: payload.stateName || order.status || 'PROCESSING',
          durationHours: Number.isFinite(durationHours) && durationHours > 0 ? durationHours : 24,
          deadline,
          setBy: context.userId,
          breached: true,
          breachedAt: now,
          breachReason: reason,
          breachedBy: context.userId || null,
          breachSource: 'MANUAL',
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return sla;
    } catch (err) {
      if (session?.inTransaction && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async checkSLACompliance(orderId, context = {}) {
    // Ownership is checked FIRST: a caller who may not read this order must
    // not be able to learn anything about it, not even whether an SLA exists.
    await this.assertOrderAccessById(orderId, context.actor, 'read the SLA of');

    const sla = await orderSLARepository.findByOrderId(orderId);
    if (!sla) return { compliant: true, reason: 'No SLA set' };
    const now = new Date();
    const deadlinePassed = now > sla.deadline;
    // A breach recorded against the SLA counts on its own: the deadline may
    // still be in the future (a mis-declared one, a dispute upheld), but the
    // service level was missed all the same.
    const breached = Boolean(sla.breached) || deadlinePassed;
    const compliant = !breached;
    const timeRemaining = sla.deadline - now;
    const hoursRemaining = Math.round(timeRemaining / 1000 / 60 / 60);

    return {
      compliant,
      deadline: sla.deadline,
      hoursRemaining,
      breached,
      breachReason: sla.breachReason || null,
      breachedAt: sla.breachedAt || null,
    };
  }

  async getSLAStatus(orderId, context = {}) {
    await this.assertOrderAccessById(orderId, context.actor, 'read the SLA of');

    const sla = await orderSLARepository.findByOrderId(orderId);
    if (!sla) return null;

    const now = new Date();
    const timeRemaining = sla.deadline - now;
    const hoursRemaining = Math.round(timeRemaining / 1000 / 60 / 60);

    return {
      stateName: sla.stateName,
      deadline: sla.deadline,
      hoursRemaining,
      percentComplete: Math.min(
        100,
        Math.max(0, 100 - (hoursRemaining / sla.durationHours) * 100)
      ),
      breached: Boolean(sla.breached) || hoursRemaining < 0,
      breachReason: sla.breachReason || null,
      breachedAt: sla.breachedAt || null,
    };
  }

  /**
   * The breach list behind the SLA dashboard.
   *
   * Two things changed here:
   *
   * 1. Overdue SLAs are FLAGGED as breached before the list is read, so the
   *    `breached` column on the record finally means something and the same
   *    rule (recorded vs. derived) applies to every consumer. The flag is
   *    stamped with the DEADLINE, not with the moment the sweep noticed it —
   *    that is when the service level was actually missed.
   *
   * 2. The list is SCOPED. A seller only ever sees breaches on their own
   *    orders; an admin sees the whole platform. Previously the seller id was
   *    accepted and then thrown away, so every seller saw every other seller's
   *    breached orders.
   */
  async getSLABreaches(sellerId, period = 'week', options = {}) {
    const { scopeToSeller = false, limit = 0, skip = 0 } = options;

    const days = PERIOD_DAYS[period] || PERIOD_DAYS.week;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const now = new Date();

    await this.detectOverdueBreaches(now);

    const filter = {
      breached: true,
      // The window is on WHEN the breach happened. Records flagged before the
      // audit trail existed carry no `breachedAt`, so they fall back to their
      // deadline.
      $or: [
        { breachedAt: { $gte: startDate, $lte: now } },
        { breachedAt: null, deadline: { $gte: startDate, $lte: now } },
      ],
    };

    if (scopeToSeller) {
      const orderIds = sellerId
        ? await orderRepository.findIdsBySellerOrShop(sellerId)
        : [];
      // A seller with no orders has no breaches — and an empty `orderId` list
      // must NOT be turned into "match everything".
      if (!orderIds.length) return [];
      filter.orderId = { $in: orderIds };
    }

    const breaches = await orderSLARepository.find({ filter, limit, skip });

    return breaches || [];
  }

  /**
   * Flag every SLA whose deadline has passed but that is not marked breached.
   *
   * Stamped with the deadline (the moment the SLA was actually missed) and
   * with source AUTO, so a breach that was pushed in by hand stays
   * distinguishable from one the platform detected on its own.
   */
  async detectOverdueBreaches(now = new Date()) {
    return orderSLARepository.markOverdue(now);
  }

  /**
   * Ownership check for a route that only carries an order id.
   *
   * Resolves the order first; a missing order is a 404, not a 403 — the
   * caller cannot be told "you may not read this" about an order that does
   * not exist.
   */
  async assertOrderAccessById(orderId, actor, action = 'access') {
    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw new ApiError('Order not found', 404);
    }
    return this.assertOrderAccess(order, actor, action);
  }

  /**
   * May this actor act on this order's SLA?
   *
   * Admins may act on any order. Everyone else may only act on an order they
   * are a party to — the buyer, the seller or the shop the order belongs to.
   */
  assertOrderAccess(order, actor, action = 'access') {
    if (!actor) {
      throw new ApiError('Unauthorized', 401);
    }

    if (isAdmin(actor)) return true;

    const actorId = String(actor.id || actor._id || '');
    if (!actorId) {
      throw new ApiError('Unauthorized', 401);
    }

    const owned = [
      order.buyerId,
      order.sellerId,
      order.shopId,
      ...(Array.isArray(order.sellerShipments)
        ? order.sellerShipments.flatMap((shipment) => [shipment.sellerId, shipment.shopId])
        : []),
    ]
      .filter(Boolean)
      .some((id) => String(id) === actorId);

    if (!owned) {
      throw new ApiError(`You are not allowed to ${action} this order`, 403);
    }

    return true;
  }
}

module.exports = new OrderSLAService();
