const requestRepository = require('../repositories/requests.repository');
const restrictionRepository = require('../repositories/restrictions.repository');
const shopRepository = require('../../selling/repositories/shops.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const orderService = require('../../fulfillment/services/orders.service');
const chatService = require('../../chat/services/chat.service');
const { sendAudit, ACTIONS } = require('../../../shared/utils/audit-client');
const { emitRequestEvent } = require('../../../shared/utils/realtime-client');
const { normalizeSpecs, optionalUnit } = require('../validators/requests.validators');

class ApiError extends Error { constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; } }
const ACTIVE = ['PENDING', 'REVIEWING', 'NEGOTIATING'];
const CANCELLABLE = [...ACTIVE, 'AGREED'];
const TERMINAL = ['CONVERTED', 'CANCELLED', 'EXPIRED', 'DECLINED'];

/** Actor labels for audits raised from here (no `req` in a service). */
function actor(user = {}) {
  return { adminId: user.id || null, adminName: user.name || user.email || user.role || null, actorRole: user.role || null };
}

/** Plain-object copy of an offer (mongoose subdoc or plain object). */
function plainOffer(item) {
  return item && typeof item.toObject === 'function' ? item.toObject() : { ...(item || {}) };
}

/** Small, safe snapshot of an offer — stored as `previous` on the next one. */
function offerSnapshot(offer) {
  if (!offer) return null;
  return {
    productId: offer.productId || null,
    productName: offer.productName || '',
    quantity: offer.quantity,
    unit: offer.unit || '',
    unitPrice: offer.unitPrice,
    totalPrice: offer.totalPrice,
    createdBy: offer.createdBy || null,
    createdByRole: offer.createdByRole || null,
  };
}

/** Escape a user-supplied string for use inside a RegExp. */
function escapeRx(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class RequestsService {
  /**
   * Realtime "list card": the request as the buyer/seller list renders it,
   * minus `attachments` (megabyte-sized data URLs belong to the REST path
   * only) and minus the activity timeline (a list row never needs it).
   */
  card(request) {
    const plain = typeof request?.toObject === 'function' ? request.toObject() : { ...request };
    if (plain) {
      delete plain.attachments;
      delete plain.activity;
    }
    return plain;
  }

  /**
   * Fire-and-forget realtime signal to both participants (and the request's
   * room). Events are small hints — the UI refetches whatever actually
   * changed, so a lost event only costs freshness, never correctness.
   */
  notify(request, type, data = {}, user = {}) {
    const plain = request && typeof request.toObject === 'function' ? request.toObject() : request;
    if (!plain || !plain._id) return;
    emitRequestEvent({
      type,
      requestId: String(plain._id),
      recipients: [plain.buyerId, plain.sellerId].filter(Boolean).map(String),
      actorId: user && user.id ? String(user.id) : null,
      data,
    });
  }

  /** One entry of the request's own timeline (bounded, readable by both sides). */
  entry(user = {}, type, summary = '', data = null) {
    return {
      type,
      actorId: user && user.id ? String(user.id) : null,
      actorRole: user && user.role ? user.role : null,
      summary: String(summary || '').slice(0, 240),
      data,
      createdAt: new Date(),
    };
  }

  /** Best-effort timeline append; returns the refreshed document (or null). */
  async record(id, entry) {
    try {
      return await requestRepository.pushActivity(id, entry);
    } catch (err) {
      return null;
    }
  }

  /**
   * Restrictions are enforced here, not in the UI: a blocked account cannot
   * bypass the platform decision by calling the API directly.
   */
  async assertNotRestricted(userId, scope) {
    const rows = await restrictionRepository.findActiveForUser(userId);
    const hit = rows.find((row) => row.scope === 'BOTH' || row.scope === scope);
    if (hit) {
      throw new ApiError(
        hit.reason ? `Your account is restricted from this feature: ${hit.reason}` : 'Your account is restricted from this feature',
        403
      );
    }
    return null;
  }

  /** Guard shared by every write: a suspended negotiation accepts no writes. */
  assertNotSuspended(request) {
    if (request.suspended) throw new ApiError('This request is suspended by the platform', 409);
  }

  /** Readable one-liner for agreement cards and activity summaries. */
  termsLabel(terms) {
    if (!terms) return 'Agreement confirmed';
    const unit = terms.unit ? ` ${terms.unit}` : '';
    const name = terms.productName ? ` — ${terms.productName}` : '';
    return `${terms.quantity}${unit} × ${terms.unitPrice} = ${terms.totalPrice}${name}`;
  }

  /** The agreed terms, frozen from the offer both sides signed off on. */
  termsFromOffer(offer, request = {}) {
    if (!offer) return null;
    return {
      offerId: offer._id ? String(offer._id) : null,
      productId: offer.productId || null,
      productName: offer.productName || request.title || '',
      quantity: offer.quantity,
      unit: offer.unit || request.unit || 'Unit',
      unitPrice: offer.unitPrice,
      totalPrice: offer.totalPrice,
      validUntil: offer.validUntil || null,
      specs: request.specs || {},
      targetPrice: request.targetPrice == null ? null : request.targetPrice,
    };
  }

  /**
   * Write a structured commerce card (requirement / offer / counter /
   * agreement) into the request thread. Cards are ordinary messages — same
   * pagination, same realtime fan-out, same history window — so both sides
   * see the negotiation as a timeline of events, not just prose.
   */
  async postCard(request, { type, text, payload = null, user = {} }) {
    let conversationId = request.conversationId;
    if (!conversationId) {
      const conversation = await chatService.createConversation({
        name: request.title,
        buyerId: request.buyerId,
        sellerId: request.sellerId,
      });
      conversationId = String(conversation._id);
      const saved = await requestRepository.findByIdAndUpdate(request._id, { conversationId });
      if (saved) request.conversationId = conversationId;
    }
    const message = await chatService.createMessage({
      conversationId,
      text: String(text || '').slice(0, 500),
      sender: String(user.id || 'system'),
      senderName: user.name || null,
      images: [],
      type,
      payload,
      label: '',
    });
    await chatService.updateConversationLastMessage(conversationId, {
      lastMessage: message.text,
      lastMessageId: String(message._id),
    });
    // Signal only: the client refetches the thread (images live in REST).
    this.notify(request, 'request.message.created', {
      status: request.status,
      message: {
        _id: String(message._id),
        sender: String(message.sender),
        text: String(message.text || '').slice(0, 200),
        type,
        imageCount: 0,
        createdAt: message.createdAt,
      },
    }, user);
    return message;
  }

  async create(payload = {}, user = {}) {
    const buyerId = user.id;
    if (!buyerId) throw new ApiError('Authentication required', 401);
    await this.assertNotRestricted(buyerId, 'BUYER');
    const title = String(payload.title || payload.subject || '').trim();
    if (title.length < 3) throw new ApiError('Request title must be at least 3 characters', 400);
    let shop = null;
    if (payload.shopId) shop = await shopRepository.findById(payload.shopId);
    if (payload.shopId && !shop) throw new ApiError('Seller business not found', 404);
    let product = null;
    if (payload.productId) {
      product = await productRepository.findById(payload.productId);
      if (!product) throw new ApiError('Product not found', 404);
      if (shop && String(product.shopId) !== String(shop._id)) throw new ApiError('Product does not belong to selected seller', 400);
    }
    const unitRaw = optionalUnit(payload);
    const unit = (!unitRaw || unitRaw === 'too_long:32') ? 'Unit' : unitRaw;
    const specs = normalizeSpecs(payload.specs);
    const details = String(payload.details || '').trim();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 10) : [];
    const request = await requestRepository.create({
      buyerId,
      sellerId: shop ? String(shop.ownerId) : null,
      shopId: shop ? String(shop._id) : null,
      productId: product ? String(product._id) : null,
      title,
      subject: title,
      details,
      quantity: Number(payload.quantity || 1),
      unit,
      productName: product ? String(product.name) : String(payload.productName || '').slice(0, 300),
      specs,
      seller: shop ? { id: String(shop.ownerId), shopId: String(shop._id), shopName: shop.name || '', name: shop.name || '' } : {},
      targetPrice: payload.targetPrice == null ? null : Number(payload.targetPrice),
      attachments,
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      buyer: { id: buyerId, name: user.name || null, email: user.email || null },
      status: 'PENDING',
    });
    // The structured requirement opens the thread so both sides negotiate on
    // the same written terms from message one.
    await this.postCard(request, {
      type: 'requirement',
      text: `Request: ${request.quantity} ${request.unit} — ${title}`,
      payload: { title, quantity: request.quantity, unit: request.unit, targetPrice: request.targetPrice, specs, details: details.slice(0, 1000) },
      user,
    });
    await this.record(request._id, this.entry(user, 'request.created', `Request created: ${title}`, { quantity: request.quantity, unit: request.unit }));
    if (attachments.length) {
      sendAudit({ action: ACTIONS.REQUEST_ATTACHMENT_ADDED, ...actor(user), targetEntity: 'request', targetId: request._id, newValue: { count: attachments.length } }).catch(() => {});
    }
    // The seller's list must show a brand-new request without a page reload.
    this.notify(request, 'request.created', { request: this.card(request) }, user);
    return request;
  }

  /**
   * Deadline sweep: every read path first closes requests whose `expiresAt`
   * passed, so an expired negotiation can never accept another message/offer.
   * Bounded and idempotent; each flip is audited once.
   */
  async sweepExpired() {
    const now = new Date();
    const overdue = await requestRepository.findOverdueIds(now);
    if (!overdue.length) return 0;
    const ids = overdue.map((row) => String(row._id));
    await requestRepository.expireByIds(ids, now);
    for (const id of ids) {
      sendAudit({ action: ACTIONS.REQUEST_EXPIRED, adminId: null, adminName: 'system', targetEntity: 'request', targetId: id, newValue: { status: 'EXPIRED' } }).catch(() => {});
      // No recipients here: every read path sweeps before it lists, so the
      // dashboards self-heal — only an open workspace (request room) needs it.
      emitRequestEvent({ type: 'request.status.changed', requestId: id, recipients: [], actorId: null, data: { status: 'EXPIRED' } });
    }
    return ids.length;
  }

  async listMine(buyerId, query = {}) {
    if (!buyerId) throw new ApiError('Authentication required', 401);
    await this.sweepExpired();
    return requestRepository.find({ filter: { buyerId, ...(query.status ? { status: query.status } : {}) } });
  }

  /**
   * Reading a request is the "Seller reviews" step: the first time the seller
   * opens it, PENDING becomes REVIEWING. Customers opening their own request
   * (and admins) never move the status.
   */
  async getForUser(id, user = {}) {
    await this.sweepExpired();
    const request = await this.assertParticipant(id, user);
    const isSellerSide = String(request.buyerId) !== String(user.id);
    if (request.status === 'PENDING' && isSellerSide && user.role !== 'ADMIN') {
      const updated = await requestRepository.findByIdAndUpdate(id, { status: 'REVIEWING' });
      const doc = await this.record(id, this.entry(user, 'request.reviewed', 'Seller opened the request', { status: 'REVIEWING' }));
      this.notify(updated, 'request.status.changed', { status: 'REVIEWING' }, user);
      return doc || updated;
    }
    return request;
  }

  async getMessages(id, user) { const request = await this.assertParticipant(id, user); if (!request.conversationId) return []; return chatService.getMessagesByConversation(request.conversationId); }

  /**
   * Admin list: tab + status filter, free-text search, party filters, date
   * range, product and price range — the filters the admin workspace exposes.
   */
  async listAll(query = {}) {
    await this.sweepExpired();
    const filter = {};
    if (query.status) filter.status = query.status;

    const TAB_STATUSES = {
      active: ['PENDING', 'REVIEWING'],
      negotiating: ['NEGOTIATING'],
      agreed: ['AGREED'],
      ordered: ['CONVERTED'],
      closed: ['DECLINED', 'CANCELLED', 'EXPIRED'],
    };
    const tab = String(query.tab || '').toLowerCase();
    if (tab === 'reported') filter['reports.0'] = { $exists: true };
    else if (tab === 'suspended') filter.suspended = true;
    else if (TAB_STATUSES[tab]) filter.status = { $in: TAB_STATUSES[tab] };

    const q = String(query.q || query.search || '').trim();
    if (q) {
      const rx = new RegExp(escapeRx(q), 'i');
      filter.$or = [
        { title: rx }, { subject: rx }, { details: rx }, { productName: rx },
        { 'buyer.name': rx }, { 'buyer.email': rx }, { 'seller.shopName': rx }, { 'seller.name': rx },
      ];
    }
    if (query.buyerId) filter.buyerId = String(query.buyerId);
    if (query.buyer) {
      const rx = new RegExp(escapeRx(query.buyer), 'i');
      filter.$and = [...(filter.$and || []), { $or: [{ 'buyer.name': rx }, { 'buyer.email': rx }, { buyerId: rx }] }];
    }
    if (query.sellerId) filter.sellerId = String(query.sellerId);
    if (query.seller) {
      const rx = new RegExp(escapeRx(query.seller), 'i');
      filter.$and = [...(filter.$and || []), { $or: [{ 'seller.shopName': rx }, { 'seller.name': rx }, { shopId: rx }] }];
    }
    if (query.shopId) filter.shopId = String(query.shopId);
    if (query.productId) filter.productId = String(query.productId);

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && !Number.isNaN(from.getTime())) filter.createdAt = { ...(filter.createdAt || {}), $gte: from };
    if (to && !Number.isNaN(to.getTime())) filter.createdAt = { ...(filter.createdAt || {}), $lte: to };

    const minPrice = query.minPrice !== undefined && query.minPrice !== null && query.minPrice !== '' ? Number(query.minPrice) : null;
    const maxPrice = query.maxPrice !== undefined && query.maxPrice !== null && query.maxPrice !== '' ? Number(query.maxPrice) : null;
    if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
      const range = {};
      if (Number.isFinite(minPrice)) range.$gte = minPrice;
      if (Number.isFinite(maxPrice)) range.$lte = maxPrice;
      filter.$and = [...(filter.$and || []), { $or: [{ targetPrice: range }, { 'offers.totalPrice': range }] }];
    }

    return requestRepository.findPaginated({ filter, page: query.page, limit: query.limit });
  }

  /** Admin dashboard: volume, funnel, conversion rate and moderation counters. */
  async stats() {
    await this.sweepExpired();
    const [rows, moderation] = await Promise.all([requestRepository.countByStatus(), requestRepository.countModeration()]);
    const byStatus = {};
    for (const row of rows) byStatus[row._id || 'UNKNOWN'] = row.count;
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const open = ACTIVE.reduce((sum, status) => sum + (byStatus[status] || 0), 0);
    const agreed = byStatus.AGREED || 0;
    const converted = byStatus.CONVERTED || 0;
    const closed = ['DECLINED', 'CANCELLED', 'EXPIRED'].reduce((sum, status) => sum + (byStatus[status] || 0), 0);
    return {
      total,
      byStatus,
      open,
      active: (byStatus.PENDING || 0) + (byStatus.REVIEWING || 0),
      negotiating: byStatus.NEGOTIATING || 0,
      agreed,
      converted,
      ordered: converted,
      closed,
      reported: moderation.reported,
      openReports: moderation.openReports,
      suspended: moderation.suspended,
      conversionRate: total ? Math.round((converted / total) * 1000) / 10 : 0,
    };
  }

  async listForShop(shopId, userId) { if (!(await this.ownsShop(shopId, userId))) throw new ApiError('You do not manage this business', 403); await this.sweepExpired(); return requestRepository.find({ filter: { shopId: String(shopId) } }); }

  async cancel(id, user) {
    const request = await this.assertParticipant(id, user);
    if (String(request.buyerId) !== String(user.id) && user.role !== 'ADMIN') throw new ApiError('Only the customer can cancel this request', 403);
    if (!CANCELLABLE.includes(request.status)) throw new ApiError(`A ${request.status.toLowerCase()} request cannot be cancelled`, 409);
    this.assertNotSuspended(request);
    const updated = await requestRepository.findByIdAndUpdate(id, { status: 'CANCELLED' });
    const doc = await this.record(id, this.entry(user, 'request.cancelled', 'Request cancelled by the buyer'));
    this.notify(updated, 'request.status.changed', { status: 'CANCELLED' }, user);
    return doc || updated;
  }

  /** Seller acknowledges the request (PENDING → REVIEWING). */
  async acceptRequest(id, user) {
    const request = await this.assertParticipant(id, user);
    if (String(request.sellerId) !== String(user.id) && user.role !== 'ADMIN') throw new ApiError('Only the seller can accept this request', 403);
    if (!ACTIVE.includes(request.status)) throw new ApiError('This request is no longer open', 409);
    this.assertNotSuspended(request);
    await this.assertNotRestricted(user.id, 'SELLER');
    if (request.status !== 'PENDING') return request;
    const updated = await requestRepository.findByIdAndUpdate(id, { status: 'REVIEWING' });
    const doc = await this.record(id, this.entry(user, 'request.accepted', 'Seller accepted the request', { status: 'REVIEWING' }));
    this.notify(updated, 'request.status.changed', { status: 'REVIEWING' }, user);
    return doc || updated;
  }

  async addMessage(id, payload, user) {
    const request = await this.assertParticipant(id, user);
    if (!ACTIVE.includes(request.status)) throw new ApiError('This request is closed for new messages', 409);
    this.assertNotSuspended(request);
    const text = String(payload.text || '').trim();
    if (!text && !(Array.isArray(payload.images) && payload.images.length)) throw new ApiError('Message text or image is required', 400);

    // A reply carries a snapshot rebuilt from the message it points at —
    // never one the client could have forged.
    let replyTo = null;
    if (payload.replyTo) {
      const original = await chatService.getMessageById(payload.replyTo);
      if (!original || (request.conversationId && String(original.conversationId) !== String(request.conversationId))) {
        throw new ApiError('The message you are replying to was not found', 400);
      }
      replyTo = {
        id: String(original._id),
        sender: String(original.sender || ''),
        text: String(original.text || '').slice(0, 200),
        label: String(original.label || ''),
        type: String(original.type || 'text'),
        createdAt: original.createdAt,
      };
    }

    let status = request.status;
    if (!request.conversationId) {
      const conversation = await chatService.createConversation({ name: request.title, buyerId: request.buyerId, sellerId: request.sellerId });
      request.conversationId = String(conversation._id);
      await requestRepository.findByIdAndUpdate(id, { conversationId: request.conversationId });
    }
    // The first human message on a PENDING request starts the review.
    if (request.status === 'PENDING') {
      status = 'REVIEWING';
      await requestRepository.findByIdAndUpdate(id, { status: 'REVIEWING' });
    }

    const message = await chatService.createMessage({
      conversationId: request.conversationId,
      text,
      sender: String(user.id),
      senderName: user.name || null,
      images: payload.images || [],
      type: 'text',
      replyTo,
      label: String(payload.label || '').slice(0, 60),
    });
    await chatService.updateConversationLastMessage(request.conversationId, { lastMessage: text, lastMessageId: String(message._id) });
    const hasImages = Array.isArray(message.images) && message.images.length > 0;
    await this.record(id, this.entry(
      user,
      replyTo ? 'message.replied' : 'message.sent',
      replyTo ? 'Replied to a message' : `Message sent${hasImages ? ' with images' : ''}`,
      { messageId: String(message._id), imageCount: hasImages ? message.images.length : 0, label: message.label || null }
    ));
    if (hasImages) {
      sendAudit({ action: ACTIONS.REQUEST_ATTACHMENT_ADDED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { imageCount: message.images.length } }).catch(() => {});
    }
    if (replyTo) {
      sendAudit({ action: ACTIONS.REQUEST_MESSAGE_REPLIED, ...actor(user), targetEntity: 'request', targetId: id, details: { replyTo: replyTo.id } }).catch(() => {});
    }
    // Signal only: the client refetches the thread (images live in REST).
    this.notify(request, 'request.message.created', {
      status,
      message: {
        _id: String(message._id),
        sender: String(message.sender),
        text: String(text || '').slice(0, 200),
        type: 'text',
        label: message.label || '',
        replyTo: replyTo ? replyTo.id : null,
        imageCount: Array.isArray(message.images) ? message.images.length : 0,
        createdAt: message.createdAt,
      },
    }, user);
    return message;
  }

  /**
   * Offer or counter-offer. Either side may quote: the seller quotes their
   * terms, the buyer counters with a different quantity/unit/price/product.
   * Only one offer is ever ACTIVE, and the new one remembers what it replaces
   * (`previous`) so the UI can show exactly what changed.
   */
  async makeOffer(id, payload, user) {
    const request = await this.assertParticipant(id, user);
    const isSellerSide = Boolean(request.sellerId && String(request.sellerId) === String(user.id));
    const isBuyerSide = String(request.buyerId) === String(user.id);
    if (!isSellerSide && !isBuyerSide && user.role !== 'ADMIN') throw new ApiError('Only the two sides can make an offer', 403);
    if (!ACTIVE.includes(request.status)) throw new ApiError('Offers can only be updated during negotiation', 409);
    this.assertNotSuspended(request);
    await this.assertNotRestricted(user.id, isBuyerSide ? 'BUYER' : 'SELLER');

    const quantity = Number(payload.quantity); const unitPrice = Number(payload.unitPrice);
    if (!Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitPrice) || unitPrice < 0) throw new ApiError('A valid quantity and unitPrice are required', 400);

    const unitRaw = optionalUnit(payload);
    const unit = (!unitRaw || unitRaw === 'too_long:32') ? (request.unit || 'Unit') : unitRaw;
    const validUntil = payload.validUntil ? new Date(payload.validUntil) : null;
    if (validUntil && Number.isNaN(validUntil.getTime())) throw new ApiError('validUntil is not a valid date', 400);

    const previous = [...(request.offers || [])].reverse().find((item) => item.status === 'ACTIVE') || null;
    const hadActive = Boolean(previous);
    const last = [...(request.offers || [])].reverse()[0] || null;
    const priceChanged = previous ? Number(previous.unitPrice) !== unitPrice : Boolean(last);
    const quantityChanged = previous ? Number(previous.quantity) !== quantity : Boolean(last);

    // An offer that never learns its product can never become an order, so the
    // id is resolved here (explicit id → the request's own product → name
    // match in the seller's catalogue).
    const productId = await this.resolveProductId(request, {
      productId: payload.productId,
      productName: payload.productName || request.title,
      strict: Boolean(payload.productId),
    });
    const offer = {
      productId,
      productName: String(payload.productName || request.title || ''),
      quantity,
      unit,
      unitPrice,
      totalPrice: quantity * unitPrice,
      note: String(payload.note || ''),
      validUntil,
      previous: offerSnapshot(previous) || offerSnapshot(last) || null,
      status: 'ACTIVE',
      createdBy: String(user.id),
      createdByRole: user.role || (isBuyerSide ? 'BUYER' : isSellerSide ? 'SELLER' : null),
      createdAt: new Date(),
    };
    const offers = (request.offers || []).map((item) => ({ ...plainOffer(item), status: 'SUPERSEDED' }));
    offers.push(offer);
    const updated = await requestRepository.findByIdAndUpdate(id, { offers, status: 'NEGOTIATING' });

    const party = isBuyerSide ? 'Buyer' : 'Seller';
    const unitLabel = unit ? ` ${unit}` : '';
    const summary = `${party} offered ${quantity}${unitLabel} × ${unitPrice} = ${offer.totalPrice}`;
    await this.record(id, this.entry(user, isBuyerSide ? 'offer.counter' : 'offer.created', summary, { quantity, unit, unitPrice, totalPrice: offer.totalPrice }));
    if (priceChanged) {
      await this.record(id, this.entry(user, 'offer.price_changed', `Unit price ${previous ? previous.unitPrice : '—'} → ${unitPrice}`, { from: previous ? previous.unitPrice : null, to: unitPrice }));
      sendAudit({ action: ACTIONS.REQUEST_PRICE_CHANGED, ...actor(user), targetEntity: 'request', targetId: id, previousValue: { unitPrice: previous ? previous.unitPrice : null }, newValue: { unitPrice, totalPrice: offer.totalPrice } }).catch(() => {});
    }
    if (quantityChanged) {
      await this.record(id, this.entry(user, 'offer.quantity_changed', `Quantity ${previous ? previous.quantity : '—'} → ${quantity}`, { from: previous ? previous.quantity : null, to: quantity }));
      sendAudit({ action: ACTIONS.REQUEST_QUANTITY_CHANGED, ...actor(user), targetEntity: 'request', targetId: id, previousValue: { quantity: previous ? previous.quantity : null }, newValue: { quantity } }).catch(() => {});
    }

    await this.postCard(updated, { type: isBuyerSide ? 'counter' : 'offer', text: summary, payload: { offer, previous: offer.previous }, user });
    sendAudit({ action: hadActive ? ACTIONS.REQUEST_OFFER_UPDATED : ACTIONS.REQUEST_OFFER_CREATED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { quantity, unit, unitPrice, totalPrice: offer.totalPrice, productId } }).catch(() => {});
    this.notify(updated, hadActive ? 'request.offer.updated' : 'request.offer.created', { status: 'NEGOTIATING', offer }, user);
    return updated;
  }

  /**
   * The catalogue product an agreement turns into.
   *
   * Order lines are re-priced from the Product collection, so an offer without
   * a product id can never become an order. Resolution order: the id already
   * on the offer → the product the request started from → an exact name match
   * in the requested shop's catalogue.
   *
   * @param {object} request
   * @param {{productId?: string|null, productName?: string, strict?: boolean}} options
   *   `strict` (used when the caller explicitly named a product) turns an
   *   unknown id into 404 instead of silently falling through.
   * @returns {Promise<string|null>} product id, or null when none is known
   */
  async resolveProductId(request, { productId = null, productName = '', strict = false } = {}) {
    if (productId) {
      const product = await productRepository.findById(productId);
      if (product) {
        await this.assertProductInScope(product, request);
        return String(product._id);
      }
      if (strict) throw new ApiError('Product not found', 404);
    }
    if (request.productId) {
      const product = await productRepository.findById(request.productId);
      if (product) return String(product._id);
    }
    const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = normalize(productName || request.title);
    // Name matching only makes sense inside the shop the request addresses.
    if (!wanted || !request.shopId) return null;
    const catalogue = await productRepository.findByShop(String(request.shopId));
    const match = catalogue.find((product) => normalize(product.name) === wanted);
    return match ? String(match._id) : null;
  }

  /** A product offered on a request must belong to the requested shop. */
  async assertProductInScope(product, request) {
    if (request.shopId && String(product.shopId) !== String(request.shopId)) {
      throw new ApiError('That product is not in this shop', 400);
    }
  }

  /**
   * Attach (or correct) the catalogue product on an offer.
   *
   * An agreement can be reached before anyone linked a product, and
   * `makeOffer` is closed once the status leaves negotiation — without this
   * the customer would be stuck with an agreement that can never be ordered.
   */
  async attachOfferProduct(id, payload, user) {
    const request = await this.assertParticipant(id, user);
    if (String(request.sellerId) !== String(user.id) && user.role !== 'ADMIN') throw new ApiError('Only the seller can attach a product', 403);
    if (![...ACTIVE, 'AGREED'].includes(request.status)) throw new ApiError('This request is closed', 409);
    this.assertNotSuspended(request);
    const list = request.offers || [];
    const accepted = [...list].reverse().find((item) => item.status === 'ACCEPTED');
    const active = [...list].reverse().find((item) => item.status === 'ACTIVE');
    const target = accepted || active;
    if (!target) throw new ApiError('There is no offer to attach a product to', 409);
    const productId = await this.resolveProductId(request, {
      productId: payload.productId,
      productName: payload.productName,
      strict: true,
    });
    const offers = list.map((item) => {
      const plain = plainOffer(item);
      if (String(plain._id) === String(target._id)) {
        plain.productId = productId;
        if (!plain.productName) plain.productName = String(payload.productName || request.title || '');
      }
      return plain;
    });
    const updated = await requestRepository.findByIdAndUpdate(id, { offers });
    sendAudit({ action: ACTIONS.REQUEST_OFFER_UPDATED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { productId } }).catch(() => {});
    this.notify(updated, 'request.offer.updated', { status: updated.status, productId }, user);
    return updated;
  }

  /**
   * Explicit, dual confirmation of the final terms (the "Agreement" tab).
   *
   * The buyer confirms by accepting the seller's live offer (this is also
   * `acceptOffer`); the seller confirms separately. Only when BOTH sides have
   * confirmed does `agreement.confirmedAt` exist — and only then can the
   * agreement become an order. Confirming is idempotent, and nobody can
   * confirm on behalf of the other party (admins included).
   */
  async confirmAgreement(id, user = {}, note = '') {
    const request = await this.assertParticipant(id, user);
    if (TERMINAL.includes(request.status)) throw new ApiError('This request is closed', 409);
    this.assertNotSuspended(request);
    const isBuyerSide = String(request.buyerId) === String(user.id);
    const isSellerSide = Boolean(request.sellerId && String(request.sellerId) === String(user.id));
    if (!isBuyerSide && !isSellerSide) throw new ApiError('Only the buyer or the seller can confirm an agreement', 403);
    await this.assertNotRestricted(user.id, isBuyerSide ? 'BUYER' : 'SELLER');

    const agreement = {
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      confirmedAt: null,
      note: '',
      terms: null,
      ...(request.agreement && typeof request.agreement === 'object' ? request.agreement : {}),
    };
    const now = new Date();
    const live = [...(request.offers || [])].reverse().find((item) => item.status === 'ACTIVE') || null;
    const accepted = [...(request.offers || [])].reverse().find((item) => item.status === 'ACCEPTED') || null;

    let offers = null;
    let status = request.status;

    if (isBuyerSide) {
      if (!agreement.buyerConfirmedAt) {
        if (accepted || request.status === 'AGREED') {
          agreement.buyerConfirmedAt = now; // accepted before confirmations existed
        } else if (live) {
          if (String(live.createdBy) === String(user.id)) {
            throw new ApiError('You cannot confirm your own counter-offer — waiting for the other side', 409);
          }
          offers = (request.offers || []).map((item) => ({ ...plainOffer(item), status: String(item._id) === String(live._id) ? 'ACCEPTED' : item.status }));
          status = 'AGREED';
          agreement.buyerConfirmedAt = now;
        } else {
          throw new ApiError('There is no live offer to confirm', 409);
        }
      }
    } else if (!agreement.sellerConfirmedAt) {
      if (!accepted && !live && request.status !== 'AGREED') {
        throw new ApiError('There are no terms to confirm yet — send an offer first', 409);
      }
      // A buyer's counter can only be accepted by the seller: confirming it
      // is exactly that acceptance (the mirror of the buyer branch above).
      // Without this the deal would deadlock — the buyer cannot accept their
      // own counter and a seller quote would never reach AGREED.
      if (!accepted && live && String(live.createdBy) !== String(user.id)) {
        offers = (request.offers || []).map((item) => ({ ...plainOffer(item), status: String(item._id) === String(live._id) ? 'ACCEPTED' : item.status }));
        status = 'AGREED';
      }
      agreement.sellerConfirmedAt = now;
    }

    const termsOffer = accepted || live;
    if (!agreement.terms && termsOffer) agreement.terms = this.termsFromOffer(termsOffer, request);
    if (note) agreement.note = String(note).slice(0, 500);
    if (agreement.buyerConfirmedAt && agreement.sellerConfirmedAt && !agreement.confirmedAt) {
      agreement.confirmedAt = now;
    }

    const update = { agreement };
    if (offers) update.offers = offers;
    if (status !== request.status) update.status = status;
    let updated = await requestRepository.findByIdAndUpdate(id, update);

    if (status !== request.status) {
      this.notify(updated, 'request.status.changed', { status }, user);
      sendAudit({ action: ACTIONS.REQUEST_OFFER_ACCEPTED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { status } }).catch(() => {});
      sendAudit({ action: ACTIONS.REQUEST_AGREED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { status } }).catch(() => {});
      updated = await this.record(id, this.entry(user, 'offer.accepted', 'Offer accepted — the request is now agreed', { status: 'AGREED' })) || updated;
    }

    if (agreement.confirmedAt) {
      await this.postCard(updated, {
        type: 'agreement',
        text: `Agreement confirmed — ${this.termsLabel(agreement.terms)}`,
        payload: { terms: agreement.terms, confirmedAt: agreement.confirmedAt },
        user,
      });
      updated = await this.record(id, this.entry(user, 'agreement.confirmed', `Agreement confirmed — ${this.termsLabel(agreement.terms)}`, { confirmedAt: agreement.confirmedAt })) || updated;
      sendAudit({ action: ACTIONS.REQUEST_AGREEMENT_CONFIRMED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { confirmedAt: agreement.confirmedAt, terms: agreement.terms } }).catch(() => {});
      this.notify(updated, 'request.agreement.confirmed', { status: updated.status, agreement }, user);
    } else {
      const party = isBuyerSide ? 'Buyer' : 'Seller';
      updated = await this.record(id, this.entry(user, 'agreement.confirmation', `${party} confirmed the agreement`, { party })) || updated;
      sendAudit({ action: ACTIONS.REQUEST_AGREEMENT_CONFIRMATION_PENDING, ...actor(user), targetEntity: 'request', targetId: id, newValue: { buyerConfirmedAt: agreement.buyerConfirmedAt, sellerConfirmedAt: agreement.sellerConfirmedAt } }).catch(() => {});
      this.notify(updated, 'request.agreement.confirmation', { status: updated.status, agreement }, user);
    }
    return updated;
  }

  /** Buyer accepts the seller's live offer — an agreement confirmation. */
  async acceptOffer(id, user) {
    return this.confirmAgreement(id, user, '');
  }

  /**
   * Reject the live offer — from whoever did NOT make it (the customer
   * rejects a seller quote, the seller rejects a buyer counter). Declining an
   * offer means "keep talking", not "close the request": the status stays
   * NEGOTIATING.
   */
  async declineOffer(id, user) {
    const request = await this.assertParticipant(id, user);
    if (!ACTIVE.includes(request.status)) throw new ApiError('This request is no longer open', 409);
    this.assertNotSuspended(request);
    const active = [...(request.offers || [])].reverse().find((item) => item.status === 'ACTIVE');
    if (!active) throw new ApiError('There is no live offer to decline', 409);
    if (String(active.createdBy) === String(user.id) && user.role !== 'ADMIN') {
      throw new ApiError('You cannot decline your own offer', 403);
    }
    const offers = (request.offers || []).map((item) => ({ ...plainOffer(item), status: String(item._id) === String(active._id) ? 'DECLINED' : item.status }));
    const updated = await requestRepository.findByIdAndUpdate(id, { offers });
    const declinedBy = String(request.buyerId) === String(user.id) ? 'Buyer' : 'Seller';
    await this.record(id, this.entry(user, 'offer.declined', `${declinedBy} declined the offer`, { quantity: active.quantity, unitPrice: active.unitPrice }));
    this.notify(updated, 'request.offer.declined', { status: 'NEGOTIATING' }, user);
    return updated;
  }

  async convertToOrder(id, payload, user) {
    const request = await this.assertParticipant(id, user);
    if (String(request.buyerId) !== String(user.id) && user.role !== 'ADMIN') throw new ApiError('Only the customer can convert this request', 403);
    if (request.status !== 'AGREED') throw new ApiError('Only an agreed request can become an order', 409);
    this.assertNotSuspended(request);
    const agreement = request.agreement && typeof request.agreement === 'object' ? request.agreement : {};
    if (!agreement.confirmedAt) {
      throw new ApiError('Both sides must confirm the agreement before an order can be created', 409);
    }
    const offer = (request.offers || []).find((item) => item.status === 'ACCEPTED');
    if (!offer) throw new ApiError('An accepted offer is required', 409);
    // The destination comes from the payload (the address the customer just
    // picked); an earlier attempt may already have stored it on the request.
    const destination = payload.destination || request.destination;
    if (!destination) throw new ApiError('Choose a delivery address to create the order', 400);
    if (!destination.sectorId || !destination.fullAddress || !destination.phone) {
      throw new ApiError('Delivery destination is required: sectorId, fullAddress, and phone are mandatory', 400);
    }
    // The order carries the agreement itself — product (linked to the
    // catalogue when known, otherwise by its agreed name), quantity and the
    // agreed price. No cart, no catalogue re-pricing, no product id required:
    // the two sides already signed off on this deal.
    const productId = await this.resolveProductId(request, {
      productId: offer.productId,
      productName: offer.productName || request.title,
    }).catch(() => null); // a stale/mismatched link must not block the order
    const order = await orderService.createAgreementOrder({
      lines: [{
        productId,
        name: String(offer.productName || request.title || 'Agreed item'),
        description: String(request.details || ''),
        quantity: offer.quantity,
        unitPrice: offer.unitPrice,
        shopId: request.shopId,
        sellerId: request.sellerId,
      }],
      user: {
        id: request.buyerId,
        name: request.buyer?.name || null,
        email: request.buyer?.email || null,
      },
      destination,
      // §11: the order keeps its origin so the request stays reachable as
      // historical context after conversion.
      requestId: String(request._id),
      shopId: request.shopId,
      sellerId: request.sellerId,
    });
    const updated = await requestRepository.findByIdAndUpdate(id, {
      status: 'CONVERTED',
      orderId: String(order._id),
      destination,
      productId,
    });
    const doc = await this.record(id, this.entry(user, 'order.created', `Order created from the agreement (${String(order._id)})`, { orderId: String(order._id) }));
    this.notify(updated, 'request.status.changed', { status: 'CONVERTED', orderId: String(order._id) }, user);
    return { request: doc || updated, order };
  }

  async decline(id, user) {
    const request = await this.assertParticipant(id, user);
    if (String(request.sellerId) !== String(user.id) && user.role !== 'ADMIN') throw new ApiError('Only the seller can decline this request', 403);
    if (!ACTIVE.includes(request.status)) throw new ApiError('This request is no longer open', 409);
    this.assertNotSuspended(request);
    const updated = await requestRepository.findByIdAndUpdate(id, { status: 'DECLINED' });
    const doc = await this.record(id, this.entry(user, 'request.declined', 'Request declined by the seller'));
    this.notify(updated, 'request.status.changed', { status: 'DECLINED' }, user);
    return doc || updated;
  }

  /**
   * Admin closes an abusive/reported request. The spec's status list has no
   * separate "suspended" state, so a platform close is recorded as DECLINED
   * with the reason kept on the request and audited as an intervention.
   */
  async adminClose(id, user = {}, reason = '') {
    const request = await requestRepository.findById(id);
    if (!request) throw new ApiError('Request not found', 404);
    if (TERMINAL.includes(request.status)) throw new ApiError(`A ${request.status.toLowerCase()} request cannot be closed`, 409);
    const text = String(reason || '').trim();
    const updated = await requestRepository.findByIdAndUpdate(id, {
      status: 'DECLINED',
      response: text || 'Closed by platform administration',
      respondedBy: String(user.id || 'admin'),
      respondedAt: new Date(),
    });
    const doc = await this.record(id, this.entry(user, 'admin.closed', `Request closed by the platform${text ? `: ${text}` : ''}`));
    this.notify(updated, 'request.status.changed', { status: 'DECLINED' }, user);
    return doc || updated;
  }

  // ── moderation: suspend / restore / attachments ─────────────────────────

  /** Freeze a negotiation without closing it: no messages, offers or orders. */
  async adminSuspend(id, user = {}, reason = '') {
    const request = await requestRepository.findById(id);
    if (!request) throw new ApiError('Request not found', 404);
    if (request.suspended) return request;
    const text = String(reason || '').trim();
    const updated = await requestRepository.findByIdAndUpdate(id, {
      suspended: true,
      suspendReason: text,
      suspendedBy: String(user.id || 'admin'),
      suspendedAt: new Date(),
    });
    const doc = await this.record(id, this.entry(user, 'admin.suspended', `Request suspended${text ? `: ${text}` : ''}`));
    this.notify(updated, 'request.moderation.changed', { suspended: true }, user);
    return doc || updated;
  }

  /** Lift a suspension: the negotiation resumes exactly where it stopped. */
  async adminRestore(id, user = {}, reason = '') {
    const request = await requestRepository.findById(id);
    if (!request) throw new ApiError('Request not found', 404);
    if (!request.suspended) return request;
    const text = String(reason || '').trim();
    const updated = await requestRepository.findByIdAndUpdate(id, {
      suspended: false,
      suspendReason: '',
      suspendedBy: null,
      suspendedAt: null,
    });
    const doc = await this.record(id, this.entry(user, 'admin.restored', `Request restored${text ? `: ${text}` : ''}`));
    this.notify(updated, 'request.moderation.changed', { suspended: false }, user);
    return doc || updated;
  }

  /** Admin removes a harmful request attachment (URL addressed). */
  async adminRemoveAttachment(id, user = {}, url = '') {
    const request = await requestRepository.findById(id);
    if (!request) throw new ApiError('Request not found', 404);
    const target = String(url || '');
    if (!target) throw new ApiError('An attachment url is required', 400);
    const list = request.attachments || [];
    const index = list.findIndex((item) => String(item.url) === target);
    if (index < 0) throw new ApiError('Attachment not found', 404);
    const attachments = list.filter((_, i) => i !== index).map((item) => ({ url: String(item.url), publicId: item.publicId || null }));
    const updated = await requestRepository.findByIdAndUpdate(id, { attachments });
    await this.record(id, this.entry(user, 'admin.attachment_removed', 'Attachment removed by the platform', { index }));
    this.notify(updated, 'request.attachment.removed', { index }, user);
    return updated;
  }

  // ── reporting ───────────────────────────────────────────────────────────

  /** Either side reports the request (abuse, fraud, off-platform deal…). */
  async report(id, payload = {}, user = {}) {
    const request = await this.assertParticipant(id, user);
    const report = {
      reportedBy: String(user.id),
      reporterRole: user.role || null,
      category: String(payload.category || 'OTHER').slice(0, 40),
      reason: String(payload.reason || '').trim(),
      details: String(payload.details || '').trim(),
      status: 'OPEN',
      createdAt: new Date(),
    };
    const updated = await requestRepository.updateWithOperators(id, { $push: { reports: report } });
    const saved = (updated.reports || [])[updated.reports.length - 1] || null;
    await this.record(id, this.entry(user, 'request.reported', `Report filed: ${report.reason}`, { category: report.category, reportId: saved ? String(saved._id) : null }));
    sendAudit({ action: ACTIONS.REQUEST_REPORTED, ...actor(user), targetEntity: 'request', targetId: id, newValue: { category: report.category, reason: report.reason }, level: 'WARNING' }).catch(() => {});
    this.notify(updated, 'request.reported', { category: report.category, reportId: saved ? String(saved._id) : null }, user);
    return updated;
  }

  /** Admin reviews a filed report: resolve it or dismiss it. */
  async adminReviewReport(id, reportId, payload = {}, user = {}) {
    const request = await requestRepository.findById(id);
    if (!request) throw new ApiError('Request not found', 404);
    const target = (request.reports || []).find((item) => String(item._id) === String(reportId));
    if (!target) throw new ApiError('Report not found', 404);
    const status = payload.status === 'DISMISSED' ? 'DISMISSED' : 'RESOLVED';
    const resolution = String(payload.resolution || '').slice(0, 500);
    const updated = await requestRepository.updateWithOperators(id, {
      $set: {
        'reports.$.status': status,
        'reports.$.reviewedBy': String(user.id || 'admin'),
        'reports.$.reviewedAt': new Date(),
        'reports.$.resolution': resolution,
      },
    }, { 'reports._id': reportId });
    await this.record(id, this.entry(user, 'admin.report_reviewed', `Report ${status.toLowerCase()}${resolution ? `: ${resolution}` : ''}`, { reportId: String(reportId), status }));
    sendAudit({ action: ACTIONS.REQUEST_REPORT_REVIEWED, ...actor(user), targetEntity: 'request', targetId: id, previousValue: { status: target.status }, newValue: { status, resolution }, reason: resolution || null, level: 'WARNING' }).catch(() => {});
    this.notify(updated, 'request.report.reviewed', { reportId: String(reportId), status }, user);
    return updated;
  }

  // ── account restrictions ────────────────────────────────────────────────

  async restrict(payload = {}, user = {}) {
    const userId = String(payload.userId || '');
    const restriction = await restrictionRepository.create({
      userId,
      scope: payload.scope || 'BUYER',
      kind: payload.kind || 'PERMANENT',
      until: payload.until ? new Date(payload.until) : null,
      reason: String(payload.reason || '').trim(),
      createdBy: user.id || null,
    });
    sendAudit({ action: ACTIONS.REQUEST_USER_RESTRICTED, ...actor(user), targetEntity: 'user', targetId: userId, newValue: { scope: restriction.scope, kind: restriction.kind, until: restriction.until }, reason: restriction.reason, level: 'WARNING' }).catch(() => {});
    return restriction;
  }

  listRestrictions(query = {}) {
    const filter = {};
    if (query.userId) filter.userId = String(query.userId);
    if (query.status) filter.status = String(query.status);
    return restrictionRepository.findPaginated({ filter, page: query.page, limit: query.limit });
  }

  async liftRestriction(restrictionId, user = {}, reason = '') {
    const existing = await restrictionRepository.findById(restrictionId);
    if (!existing) throw new ApiError('Restriction not found', 404);
    if (existing.status === 'LIFTED') return existing;
    const lifted = await restrictionRepository.lift(restrictionId, {
      liftedBy: user.id || null,
      liftReason: String(reason || '').slice(0, 500),
    });
    sendAudit({ action: ACTIONS.REQUEST_USER_RESTRICTION_LIFTED, ...actor(user), targetEntity: 'user', targetId: existing.userId, previousValue: { status: 'ACTIVE' }, newValue: { status: 'LIFTED' }, reason: reason || null }).catch(() => {});
    return lifted;
  }

  async assertParticipant(id, user = {}) { const request = await requestRepository.findById(id); if (!request) throw new ApiError('Request not found', 404); const allowed = user.role === 'ADMIN' || String(request.buyerId) === String(user.id) || (request.sellerId && String(request.sellerId) === String(user.id)); if (!allowed) throw new ApiError('Request not found', 404); return request; }
  async ownsShop(shopId, userId) { const shops = await shopRepository.find({ filter: { ownerId: userId } }); return shops.some((shop) => String(shop._id) === String(shopId)); }
}
module.exports = new RequestsService();
module.exports.ApiError = ApiError;
module.exports.ACTIVE_STATUSES = ACTIVE;
