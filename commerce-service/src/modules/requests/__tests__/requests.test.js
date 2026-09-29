/**
 * Request Management tests — customer request → negotiation → order.
 *
 * Uses Node's built-in test runner (`node --test`) against a dedicated test DB.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_requests$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_requests';

let Request;
let Shop;
let Product;
let Order;
let service;
let validators;

const CUSTOMER = '507f1f77bcf86cd799439001';
const SELLER = '507f1f77bcf86cd799439002';
const STRANGER = '507f1f77bcf86cd799439003';
const ADMIN = { id: '507f1f77bcf86cd799439009', role: 'ADMIN', name: 'Ops' };
const CUSTOMER_USER = { id: CUSTOMER, role: 'CUSTOMER', name: 'Buyer', email: 'b@t.com' };
const SELLER_USER = { id: SELLER, role: 'SELLER', name: 'Seller' };

before(async () => {
  await mongoose.connect(DB_URL);
  Request = require('../models/Requests');
  Shop = require('../../selling/models/Shops');
  Product = require('../../catalog/models/Products');
  Order = require('../../fulfillment/models/Orders');
  await Promise.all([
    Request.deleteMany({}), Shop.deleteMany({}), Product.deleteMany({}), Order.deleteMany({}),
  ]);
  await Promise.all([Request.init(), Shop.init(), Product.init(), Order.init()]);
  service = require('../services/requests.service');
  validators = require('../validators/requests.validators');
});

after(async () => { await mongoose.disconnect(); });

afterEach(async () => {
  await Promise.all([
    Request.deleteMany({}), Shop.deleteMany({}), Product.deleteMany({}), Order.deleteMany({}),
  ]);
});

async function seedShop(overrides = {}) {
  return Shop.create({
    name: 'Request Test Shop',
    email: 'shop@t.com',
    ownerId: SELLER,
    address: 'Bole, Addis Ababa',
    status: 'APPROVED',
    avatar: { public_id: 'x', url: '/uploads/x.jpg' },
    ...overrides,
  });
}

async function seedProduct(shop, overrides = {}) {
  return Product.create({
    name: 'Request Test Product',
    description: 'A test product',
    category: 'Electronics',
    discountPrice: 100,
    originalPrice: 120,
    stock: 10,
    reserved: 0,
    images: ['img.jpg'],
    status: 'PUBLISHED',
    isActive: true,
    shopId: String(shop._id),
    shop: { _id: String(shop._id), name: shop.name, status: 'APPROVED', showOnPublic: true, ownerId: SELLER },
    ratings: 4.5,
    ...overrides,
  });
}

async function createOpenRequest(overrides = {}) {
  const shop = overrides._shop || await seedShop();
  const product = overrides._product || await seedProduct(shop);
  const request = await service.create({
    shopId: String(shop._id),
    productId: String(product._id),
    title: 'Need 50 USB-C cables',
    details: 'White, 1m',
    quantity: 50,
    ...overrides,
  }, CUSTOMER_USER);
  return { request, shop, product };
}

const DESTINATION = {
  sectorId: 'sector-1',
  fullAddress: 'Bole Road, House 12',
  phone: '+251911000000',
};

// ── create ─────────────────────────────────────────────────────────────
describe('Requests · create', () => {
  it('rejects a title shorter than 3 characters', async () => {
    await assert.rejects(() => service.create({ title: 'ab' }, CUSTOMER_USER), (err) => err.statusCode === 400);
  });

  it('404s for an unknown shop', async () => {
    await assert.rejects(
      () => service.create({ title: 'Valid title', shopId: new mongoose.Types.ObjectId().toString() }, CUSTOMER_USER),
      (err) => err.statusCode === 404
    );
  });

  it('creates a PENDING request with the buyer snapshot and quantity', async () => {
    const { request, shop } = await createOpenRequest();
    assert.strictEqual(request.status, 'PENDING');
    assert.strictEqual(String(request.buyerId), CUSTOMER);
    assert.strictEqual(String(request.shopId), String(shop._id));
    assert.strictEqual(request.quantity, 50);
    assert.strictEqual(String(request.buyer.id), CUSTOMER);
    assert.strictEqual(request.offers.length, 0);
  });
});

// ── access + review state ──────────────────────────────────────────────
describe('Requests · access and review state', () => {
  it('hides a request from a stranger (404, no existence leak)', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.getForUser(request._id, { id: STRANGER, role: 'CUSTOMER' }), (err) => err.statusCode === 404);
  });

  it("flips PENDING → REVIEWING when the seller first opens it", async () => {
    const { request } = await createOpenRequest();
    const seen = await service.getForUser(request._id, SELLER_USER);
    assert.strictEqual(seen.status, 'REVIEWING');
  });

  it('leaves the status untouched when the customer opens it', async () => {
    const { request } = await createOpenRequest();
    const seen = await service.getForUser(request._id, CUSTOMER_USER);
    assert.strictEqual(seen.status, 'PENDING');
  });
});

// ── negotiation ────────────────────────────────────────────────────────
describe('Requests · negotiation', () => {
  it("moves to NEGOTIATING and supersedes the previous seller's offer", async () => {
    const { request } = await createOpenRequest();
    const first = await service.makeOffer(request._id, { quantity: 50, unitPrice: 80, note: 'first' }, SELLER_USER);
    assert.strictEqual(first.status, 'NEGOTIATING');
    const second = await service.makeOffer(request._id, { quantity: 50, unitPrice: 75, note: 'second' }, SELLER_USER);
    assert.strictEqual(second.offers.length, 2);
    assert.strictEqual(second.offers.filter((o) => o.status === 'ACTIVE').length, 1);
    assert.strictEqual(second.offers[0].status, 'SUPERSEDED');
    assert.strictEqual(second.offers[1].unitPrice, 75);
  });

  it('lets the customer decline the active offer while the request stays open', async () => {
    const { request } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 80 }, SELLER_USER);
    const declined = await service.declineOffer(request._id, CUSTOMER_USER);
    assert.strictEqual(declined.status, 'NEGOTIATING');
    assert.strictEqual(declined.offers[0].status, 'DECLINED');
    // Negotiation can continue after a rejection.
    const again = await service.makeOffer(request._id, { quantity: 50, unitPrice: 70 }, SELLER_USER);
    assert.strictEqual(again.offers.filter((o) => o.status === 'ACTIVE').length, 1);
  });

  it('refuses an offer decline from the seller', async () => {
    const { request } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 80 }, SELLER_USER);
    await assert.rejects(() => service.declineOffer(request._id, SELLER_USER), (err) => err.statusCode === 403);
  });

  it('refuses an offer decline when there is no active offer', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.declineOffer(request._id, CUSTOMER_USER), (err) => err.statusCode === 409);
  });

  it('lets the buyer counter the seller with a different quantity and price', async () => {
    const { request } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 80, unit: 'Piece' }, SELLER_USER);
    const countered = await service.makeOffer(request._id, { quantity: 40, unitPrice: 70, unit: 'Piece' }, CUSTOMER_USER);
    assert.strictEqual(countered.status, 'NEGOTIATING');
    assert.strictEqual(countered.offers.length, 2);
    assert.strictEqual(countered.offers[0].status, 'SUPERSEDED'); // seller quote replaced
    const live = countered.offers[1];
    assert.strictEqual(live.status, 'ACTIVE');
    assert.strictEqual(live.quantity, 40);
    assert.strictEqual(live.unitPrice, 70);
    assert.strictEqual(String(live.createdBy), CUSTOMER);
    // The counter remembers what it replaces, so the UI can show the diff.
    assert.strictEqual(live.previous.unitPrice, 80);
    assert.strictEqual(live.previous.quantity, 50);
    // The seller (not the buyer) accepts the buyer's counter.
    await assert.rejects(() => service.acceptOffer(request._id, CUSTOMER_USER), (err) => err.statusCode === 409);
  });

  it('AGREED freezes the request: no further offers', async () => {
    const { request } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 80 }, SELLER_USER);
    const agreed = await service.acceptOffer(request._id, CUSTOMER_USER);
    assert.strictEqual(agreed.status, 'AGREED');
    assert.strictEqual(agreed.offers[0].status, 'ACCEPTED');
    await assert.rejects(() => service.makeOffer(request._id, { quantity: 1, unitPrice: 1 }, SELLER_USER), (err) => err.statusCode === 409);
    await assert.rejects(() => service.declineOffer(request._id, CUSTOMER_USER), (err) => err.statusCode === 409);
  });
});

// ── expiry ─────────────────────────────────────────────────────────────
describe('Requests · expiry', () => {
  it('sweeps an overdue open request to EXPIRED and then blocks messages', async () => {
    const { request } = await createOpenRequest({ expiresAt: new Date(Date.now() - 60_000) });
    const swept = await service.sweepExpired();
    assert.ok(swept >= 1);
    const reloaded = await Request.findById(request._id);
    assert.strictEqual(reloaded.status, 'EXPIRED');
    await assert.rejects(() => service.addMessage(request._id, { text: 'too late' }, SELLER_USER), (err) => err.statusCode === 409);
  });

  it('leaves a request with no deadline open', async () => {
    const { request } = await createOpenRequest();
    await service.sweepExpired();
    const reloaded = await Request.findById(request._id);
    assert.strictEqual(reloaded.status, 'PENDING');
  });
});

// ── messages ───────────────────────────────────────────────────────────
describe('Requests · messages', () => {
  it('creates a conversation on the first message and archives it on the request', async () => {
    const { request } = await createOpenRequest();
    const message = await service.addMessage(request._id, { text: 'Hello seller' }, CUSTOMER_USER);
    assert.strictEqual(message.text, 'Hello seller');
    const reloaded = await Request.findById(request._id);
    assert.ok(reloaded.conversationId);
    assert.strictEqual(reloaded.status, 'REVIEWING');
    const messages = await service.getMessages(request._id, SELLER_USER);
    // The structured requirement card opens the thread, then the chat message.
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].type, 'requirement');
    assert.strictEqual(messages[1].text, 'Hello seller');
  });

  it('rejects an empty message', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.addMessage(request._id, {}, CUSTOMER_USER), (err) => err.statusCode === 400);
  });

  it('rebuilds a trusted reply snapshot instead of trusting the client', async () => {
    const { request } = await createOpenRequest();
    const original = await service.addMessage(request._id, { text: 'Do you have stock?' }, CUSTOMER_USER);
    const reply = await service.addMessage(
      request._id,
      { text: 'Yes, 50 left', replyTo: String(original._id), label: '' },
      SELLER_USER
    );
    assert.ok(reply.replyTo);
    assert.strictEqual(reply.replyTo.id, String(original._id));
    assert.strictEqual(reply.replyTo.text, 'Do you have stock?');
    // Pointing at a message from another conversation is rejected.
    await assert.rejects(
      () => service.addMessage(request._id, { text: 'nope', replyTo: new mongoose.Types.ObjectId().toString() }, SELLER_USER),
      (err) => err.statusCode === 400
    );
  });
});

// ── conversion ─────────────────────────────────────────────────────────
describe('Requests · conversion', () => {
  it('refuses conversion before the request is AGREED', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER), (err) => err.statusCode === 409);
  });

  it('refuses conversion without a delivery destination', async () => {
    const { request, product } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 2, unitPrice: 100, productId: String(product._id) }, SELLER_USER);
    await service.acceptOffer(request._id, CUSTOMER_USER);
    await service.confirmAgreement(request._id, SELLER_USER);
    await assert.rejects(
      () => service.convertToOrder(request._id, {}, CUSTOMER_USER),
      (err) => err.statusCode === 400 && /delivery address/i.test(err.message)
    );
    await assert.rejects(
      () => service.convertToOrder(request._id, { destination: { fullAddress: 'Bole Road' } }, CUSTOMER_USER),
      (err) => err.statusCode === 400 && /sectorId/.test(err.message)
    );
    // Still AGREED — a rejected conversion must not burn the agreement.
    const reloaded = await Request.findById(request._id);
    assert.strictEqual(reloaded.status, 'AGREED');
  });

  it('falls back to a destination already stored on the request', async () => {
    const { request, product } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 2, unitPrice: 100, productId: String(product._id) }, SELLER_USER);
    await service.acceptOffer(request._id, CUSTOMER_USER);
    await service.confirmAgreement(request._id, SELLER_USER);
    await Request.findByIdAndUpdate(request._id, { destination: DESTINATION });

    const result = await service.convertToOrder(request._id, {}, CUSTOMER_USER);
    assert.strictEqual(result.request.status, 'CONVERTED');
    assert.strictEqual(result.request.destination.sectorId, DESTINATION.sectorId);
  });

  it('creates an order that carries the originating requestId', async () => {
    const { request, product } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 2, unitPrice: 100, productId: String(product._id) }, SELLER_USER);
    await service.acceptOffer(request._id, CUSTOMER_USER);
    await service.confirmAgreement(request._id, SELLER_USER);

    const result = await service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER);

    assert.strictEqual(result.request.status, 'CONVERTED');
    assert.strictEqual(String(result.request.orderId), String(result.order._id));
    // The chosen ship-to address is remembered on the request.
    assert.strictEqual(result.request.destination.fullAddress, DESTINATION.fullAddress);
    assert.strictEqual(result.request.destination.phone, DESTINATION.phone);
    const order = await Order.findById(result.order._id);
    assert.strictEqual(String(order.requestId), String(request._id));
    assert.strictEqual(String(order.buyerId), CUSTOMER);
    const reloaded = await Request.findById(request._id);
    assert.strictEqual(reloaded.status, 'CONVERTED');
    assert.strictEqual(reloaded.destination.sectorId, DESTINATION.sectorId);
  });

  it('creates the order straight from the agreement — no product id, no cart', async () => {
    // A request that never pointed at a catalogue product: the agreement ITSELF
    // is the purchase order (product by name, agreed qty and price).
    const shop = await seedShop();
    const request = await service.create({
      shopId: String(shop._id),
      title: 'Need 50 USB-C cables',
      details: 'White, 1m',
      quantity: 50,
    }, CUSTOMER_USER);
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 45, productName: 'USB-C cable (white)' }, SELLER_USER);
    await service.acceptOffer(request._id, CUSTOMER_USER);
    await service.confirmAgreement(request._id, SELLER_USER);

    const result = await service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER);

    const order = await Order.findById(result.order._id);
    assert.strictEqual(String(order.requestId), String(request._id));
    assert.strictEqual(String(order.buyerId), CUSTOMER);
    assert.strictEqual(String(order.sellerId), SELLER);
    assert.strictEqual(order.status, 'Processing');
    assert.strictEqual(order.cart.length, 1);
    const line = order.cart[0];
    assert.strictEqual(line.name, 'USB-C cable (white)');
    assert.strictEqual(line.quantity, 50);
    assert.strictEqual(line.price, 45); // the agreed price
    assert.strictEqual(order.subtotal, 45 * 50);
    assert.strictEqual(order.totalPrice, Math.round((45 * 50 * 1.03) * 100) / 100);
    assert.strictEqual(line.stockManaged, false);
    assert.ok(!line.productId); // never required for an agreement order
    // Delivery is part of the same handoff as a normal checkout.
    const reloaded = await Request.findById(request._id);
    assert.strictEqual(reloaded.status, 'CONVERTED');
    assert.strictEqual(String(reloaded.orderId), String(order._id));
  });

  it('keeps the agreed price instead of re-pricing from the catalogue', async () => {
    const { request, product } = await createOpenRequest(); // catalogue price: 100
    await service.makeOffer(request._id, { quantity: 2, unitPrice: 45, productId: String(product._id) }, SELLER_USER);
    await service.acceptOffer(request._id, CUSTOMER_USER);
    await service.confirmAgreement(request._id, SELLER_USER);

    const result = await service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER);
    const order = await Order.findById(result.order._id);
    const line = order.cart[0];
    assert.strictEqual(String(line.productId), String(product._id));
    assert.strictEqual(line.price, 45); // negotiated, NOT the catalogue 100
    assert.strictEqual(order.subtotal, 90);
    // Agreement lines are never stock-managed — inventory must be untouched.
    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.stock, 10);
    assert.strictEqual(reloaded.reserved, 0);
  });

  it('every stock operation skips agreement lines', async () => {
    const { product } = await createOpenRequest();
    const orderService = require('../../fulfillment/services/orders.service');
    const line = { name: 'Negotiated item', quantity: 5, stockManaged: false };

    assert.strictEqual((await orderService.reserveInventory([line], null, [])).length, 0);
    assert.strictEqual((await orderService.deductInventoryOnPayment([line], null)).length, 0);
    assert.strictEqual((await orderService.releaseInventory([line], null)).length, 0);
    const availability = await orderService.validateInventoryAvailability([line]);
    assert.strictEqual(availability.items.length, 0);

    const reloaded = await Product.findById(product._id);
    assert.strictEqual(reloaded.stock, 10);
    assert.strictEqual(reloaded.reserved, 0);
  });
});

// ── offer product link (optional) ──────────────────────────────────────
describe('Requests · linking a product to an offer', () => {
  async function createAgreementWithoutProduct() {
    const shop = await seedShop();
    const request = await service.create({
      shopId: String(shop._id),
      title: 'Handmade oak desk',
      quantity: 1,
    }, CUSTOMER_USER);
    await service.makeOffer(request._id, { quantity: 1, unitPrice: 4000, productName: 'Handmade oak desk' }, SELLER_USER);
    await service.acceptOffer(request._id, CUSTOMER_USER);
    await service.confirmAgreement(request._id, SELLER_USER);
    return { request, shop };
  }

  it('lets the seller link a product after the agreement is reached', async () => {
    const { request, shop } = await createAgreementWithoutProduct();
    const product = await seedProduct(shop, { name: 'Oak Desk' });

    const updated = await service.attachOfferProduct(request._id, { productId: String(product._id) }, SELLER_USER);

    const offer = updated.offers.find((item) => item.status === 'ACCEPTED');
    assert.strictEqual(String(offer.productId), String(product._id));
    assert.strictEqual(updated.status, 'AGREED'); // linking never moves the status
    // And the conversion now carries the catalogue reference on the order line.
    const result = await service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER);
    assert.strictEqual(String(result.order.cart[0].productId), String(product._id));
  });

  it('is seller-only and rejects a product from another shop', async () => {
    const { request, shop } = await createAgreementWithoutProduct();
    await assert.rejects(
      () => service.attachOfferProduct(request._id, { productId: new mongoose.Types.ObjectId().toString() }, CUSTOMER_USER),
      (err) => err.statusCode === 403
    );

    const otherShop = await seedShop({ email: 'other@t.com' });
    const foreign = await seedProduct(otherShop);
    await assert.rejects(
      () => service.attachOfferProduct(request._id, { productId: String(foreign._id) }, SELLER_USER),
      (err) => err.statusCode === 400
    );

    const own = await seedProduct(shop, { name: 'Own Desk' });
    await assert.rejects(
      () => service.attachOfferProduct(request._id, { productId: new mongoose.Types.ObjectId().toString() }, SELLER_USER),
      (err) => err.statusCode === 404
    );
    assert.ok(own);
  });
});

// ── lifecycle actions ──────────────────────────────────────────────────
describe('Requests · lifecycle actions', () => {
  it('seller accept is customer-forbidden and only meaningful while PENDING', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.acceptRequest(request._id, CUSTOMER_USER), (err) => err.statusCode === 403);
    const accepted = await service.acceptRequest(request._id, SELLER_USER);
    assert.strictEqual(accepted.status, 'REVIEWING');
    // Idempotent once already in review.
    const again = await service.acceptRequest(request._id, SELLER_USER);
    assert.strictEqual(again.status, 'REVIEWING');
  });

  it('only the seller can decline, and only while open', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.decline(request._id, CUSTOMER_USER), (err) => err.statusCode === 403);
    const declined = await service.decline(request._id, SELLER_USER);
    assert.strictEqual(declined.status, 'DECLINED');
    await assert.rejects(() => service.decline(request._id, SELLER_USER), (err) => err.statusCode === 409);
  });

  it('customer cancels an open request but not a converted one', async () => {
    const { request } = await createOpenRequest();
    const cancelled = await service.cancel(request._id, CUSTOMER_USER);
    assert.strictEqual(cancelled.status, 'CANCELLED');
    await assert.rejects(() => service.cancel(request._id, CUSTOMER_USER), (err) => err.statusCode === 409);
  });
});

// ── admin ──────────────────────────────────────────────────────────────
describe('Requests · admin', () => {
  it('searches, filters and paginates the request list', async () => {
    await createOpenRequest({ title: 'Wireless headphones bulk order', details: 'need 200 units' });
    await createOpenRequest({ title: 'Stainless steel pots', details: 'kitchen stock' });

    const page = await service.listAll({ q: 'headphones', page: 1, limit: 10 });
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.requests.length, 1);
    assert.match(page.requests[0].title, /Wireless headphones/);
    assert.strictEqual(page.page, 1);
    assert.strictEqual(page.totalPages, 1);

    const filtered = await service.listAll({ status: 'PENDING' });
    assert.strictEqual(filtered.total, 2);
    const empty = await service.listAll({ status: 'CANCELLED' });
    assert.strictEqual(empty.total, 0);
  });

  it('reports pipeline counters and a conversion rate', async () => {
    await createOpenRequest();
    const second = await createOpenRequest();
    await service.decline(second.request._id, SELLER_USER);

    const stats = await service.stats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.byStatus.PENDING, 1);
    assert.strictEqual(stats.byStatus.DECLINED, 1);
    assert.strictEqual(stats.open, 1);
    assert.strictEqual(stats.conversionRate, 0);
  });

  it('admin close rejects an already terminal request', async () => {
    const { request } = await createOpenRequest();
    await service.cancel(request._id, CUSTOMER_USER);
    await assert.rejects(() => service.adminClose(request._id, ADMIN, 'spam'), (err) => err.statusCode === 409);
  });

  it('admin close marks an open request DECLINED and keeps the reason', async () => {
    const { request } = await createOpenRequest();
    const closed = await service.adminClose(request._id, ADMIN, 'Reported as abusive');
    assert.strictEqual(closed.status, 'DECLINED');
    assert.match(closed.response, /abusive/);
    assert.strictEqual(String(closed.respondedBy), ADMIN.id);
  });
});

// ── dual agreement confirmation ─────────────────────────────────────────
describe('Requests · agreement confirmation', () => {
  it('waits for BOTH sides before the agreement can become an order', async () => {
    const { request, product } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 2, unitPrice: 100, productId: String(product._id) }, SELLER_USER);

    const buyerConfirmed = await service.acceptOffer(request._id, CUSTOMER_USER);
    assert.strictEqual(buyerConfirmed.status, 'AGREED');
    assert.ok(buyerConfirmed.agreement.buyerConfirmedAt);
    assert.strictEqual(buyerConfirmed.agreement.sellerConfirmedAt, null);
    assert.strictEqual(buyerConfirmed.agreement.confirmedAt, null);
    await assert.rejects(
      () => service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER),
      (err) => err.statusCode === 409 && /confirm the agreement/i.test(err.message)
    );

    const bothConfirmed = await service.confirmAgreement(request._id, SELLER_USER);
    assert.ok(bothConfirmed.agreement.sellerConfirmedAt);
    assert.ok(bothConfirmed.agreement.confirmedAt);
    assert.strictEqual(bothConfirmed.agreement.terms.unitPrice, 100);

    const result = await service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER);
    assert.strictEqual(result.request.status, 'CONVERTED');
  });

  it('is idempotent per side and refuses an admin acting as a party', async () => {
    const { request, product } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 5, unitPrice: 20, productId: String(product._id) }, SELLER_USER);
    const first = await service.confirmAgreement(request._id, SELLER_USER);
    const again = await service.confirmAgreement(request._id, SELLER_USER);
    assert.strictEqual(String(again.agreement.sellerConfirmedAt), String(first.agreement.sellerConfirmedAt));
    // An admin can moderate but never sign for the buyer or the seller.
    await assert.rejects(() => service.confirmAgreement(request._id, ADMIN), (err) => err.statusCode === 403);
  });

  it('the seller cannot confirm before there are any terms', async () => {
    const { request } = await createOpenRequest();
    await assert.rejects(() => service.confirmAgreement(request._id, SELLER_USER), (err) => err.statusCode === 409);
  });

  it('lets the seller accept a buyer counter without deadlocking the deal', async () => {
    const { request, product } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 10, unitPrice: 500, productId: String(product._id) }, SELLER_USER);
    // The buyer counters last — the buyer can never accept their own offer,
    // so the seller's confirmation must BE that acceptance.
    const counter = await service.makeOffer(request._id, { quantity: 10, unitPrice: 450 }, CUSTOMER_USER);
    const live = [...counter.offers].reverse().find((offer) => offer.status === 'ACTIVE');
    assert.strictEqual(String(live.createdBy), String(CUSTOMER_USER.id));

    const sellerConfirmed = await service.confirmAgreement(request._id, SELLER_USER);
    assert.strictEqual(sellerConfirmed.status, 'AGREED');
    assert.strictEqual(sellerConfirmed.agreement.sellerConfirmedAt instanceof Date, true);
    assert.strictEqual(sellerConfirmed.agreement.confirmedAt, null);
    const accepted = [...sellerConfirmed.offers].reverse().find((offer) => offer.status === 'ACCEPTED');
    assert.strictEqual(accepted.unitPrice, 450);

    // The buyer's own counter is now the accepted offer — confirming works.
    const both = await service.confirmAgreement(request._id, CUSTOMER_USER);
    assert.ok(both.agreement.buyerConfirmedAt);
    assert.ok(both.agreement.confirmedAt);
    assert.strictEqual(both.agreement.terms.unitPrice, 450);
    const result = await service.convertToOrder(request._id, { destination: DESTINATION }, CUSTOMER_USER);
    assert.strictEqual(result.request.status, 'CONVERTED');
  });
});

// ── structured thread + timeline ────────────────────────────────────────
describe('Requests · thread and timeline', () => {
  it('opens the thread with a requirement card and records a bounded activity log', async () => {
    const { request } = await createOpenRequest({ unit: 'Dozen', specs: { brand: 'Anker', color: 'Black' } });
    const messages = await service.getMessages(request._id, CUSTOMER_USER);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'requirement');
    assert.strictEqual(messages[0].payload.unit, 'Dozen');
    assert.strictEqual(messages[0].payload.specs.brand, 'Anker');

    await service.addMessage(request._id, { text: 'Hello' }, CUSTOMER_USER);
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 75 }, SELLER_USER);
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 70 }, SELLER_USER);
    const reloaded = await Request.findById(request._id);
    const types = reloaded.activity.map((entry) => entry.type);
    assert.ok(types.includes('request.created'));
    assert.ok(types.includes('message.sent'));
    assert.ok(types.includes('offer.created'));
    assert.ok(types.includes('offer.price_changed'));
  });

  it('turns an offer into a structured card in the discussion', async () => {
    const { request } = await createOpenRequest();
    await service.makeOffer(request._id, { quantity: 50, unitPrice: 80, unit: 'Piece' }, SELLER_USER);
    const messages = await service.getMessages(request._id, CUSTOMER_USER);
    const card = messages.find((m) => m.type === 'offer');
    assert.ok(card, 'expected an offer card');
    assert.strictEqual(card.payload.offer.unitPrice, 80);
    assert.strictEqual(card.payload.offer.unit, 'Piece');
  });
});

// ── moderation ──────────────────────────────────────────────────────────
describe('Requests · moderation', () => {
  it('suspend freezes every write and restore reopens it', async () => {
    const { request } = await createOpenRequest();
    const suspended = await service.adminSuspend(request._id, ADMIN, 'Under review');
    assert.strictEqual(suspended.suspended, true);
    assert.match(suspended.suspendReason, /review/);

    await assert.rejects(() => service.addMessage(request._id, { text: 'hi' }, CUSTOMER_USER), (err) => err.statusCode === 409);
    await assert.rejects(() => service.makeOffer(request._id, { quantity: 1, unitPrice: 1 }, SELLER_USER), (err) => err.statusCode === 409);
    await assert.rejects(() => service.cancel(request._id, CUSTOMER_USER), (err) => err.statusCode === 409);

    const restored = await service.adminRestore(request._id, ADMIN, 'False alarm');
    assert.strictEqual(restored.suspended, false);
    const message = await service.addMessage(request._id, { text: 'back to normal' }, CUSTOMER_USER);
    assert.strictEqual(message.text, 'back to normal');
  });

  it('files a report, counts it in stats and lets an admin resolve it', async () => {
    const { request } = await createOpenRequest();
    const reported = await service.report(request._id, { category: 'FRAUD', reason: 'Asked to pay off-platform' }, SELLER_USER);
    const report = reported.reports[reported.reports.length - 1];
    assert.strictEqual(report.status, 'OPEN');
    assert.strictEqual(String(report.reportedBy), SELLER);

    const stats = await service.stats();
    assert.strictEqual(stats.reported, 1);
    assert.strictEqual(stats.openReports, 1);

    const filtered = await service.listAll({ tab: 'reported' });
    assert.strictEqual(filtered.total, 1);

    const reviewed = await service.adminReviewReport(request._id, String(report._id), { status: 'RESOLVED', resolution: 'Warning sent' }, ADMIN);
    assert.strictEqual(reviewed.reports[reviewed.reports.length - 1].status, 'RESOLVED');
    assert.strictEqual((await service.stats()).openReports, 0);
  });

  it('removes an attachment by url', async () => {
    const { request } = await createOpenRequest({ attachments: [{ url: 'data:image/png;base64,AAA' }, { url: 'data:image/png;base64,BBB' }] });
    const updated = await service.adminRemoveAttachment(request._id, ADMIN, 'data:image/png;base64,AAA');
    assert.strictEqual(updated.attachments.length, 1);
    assert.strictEqual(updated.attachments[0].url, 'data:image/png;base64,BBB');
    await assert.rejects(() => service.adminRemoveAttachment(request._id, ADMIN, 'missing'), (err) => err.statusCode === 404);
  });

  it('blocks a restricted buyer at the API, and lifting restores access', async () => {
    const restriction = await service.restrict({ userId: CUSTOMER, scope: 'BUYER', kind: 'PERMANENT', reason: 'Repeated abuse' }, ADMIN);
    await assert.rejects(
      () => service.create({ title: 'Should not be allowed' }, CUSTOMER_USER),
      (err) => err.statusCode === 403 && /restricted/i.test(err.message)
    );
    await service.liftRestriction(String(restriction._id), ADMIN, 'Appealed');
    const allowed = await service.create({ title: 'Allowed again' }, CUSTOMER_USER);
    assert.strictEqual(allowed.title, 'Allowed again');
  });
});

// ── validators ─────────────────────────────────────────────────────────
function runValidator(fn, req) {
  const out = { status: null, body: null, nextCalled: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  fn(req, res, () => { out.nextCalled = true; });
  return out;
}

describe('Requests · validators', () => {
  it('accepts the payload the buyer form actually sends', () => {
    const result = runValidator(validators.validateCreateRequest, {
      body: { title: 'Need 50 USB-C cables', details: 'White', quantity: 50, targetPrice: 80, shopId: null },
    });
    assert.strictEqual(result.nextCalled, true, JSON.stringify(result.body));
  });

  it('rejects a short title and a non-integer quantity', () => {
    const result = runValidator(validators.validateCreateRequest, { body: { title: 'ab', quantity: 2.5 } });
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.code, 'VALIDATION_ERROR');
    assert.ok(result.body.errors.length >= 2);
  });

  it('validates the admin list query', () => {
    assert.strictEqual(runValidator(validators.validateListQuery, { query: { status: 'PENDING', page: '2', limit: '20' } }).nextCalled, true);
    assert.strictEqual(runValidator(validators.validateListQuery, { query: { status: 'NOPE' } }).nextCalled, false);
    assert.strictEqual(runValidator(validators.validateListQuery, { query: { page: '0' } }).nextCalled, false);
    assert.strictEqual(runValidator(validators.validateListQuery, { query: { limit: '5000' } }).nextCalled, false);
  });

  it('requires text or an image for a message', () => {
    assert.strictEqual(runValidator(validators.validateAddMessage, { body: {} }).nextCalled, false);
    assert.strictEqual(runValidator(validators.validateAddMessage, { body: { text: 'hi' } }).nextCalled, true);
    assert.strictEqual(runValidator(validators.validateAddMessage, { body: { images: [{ url: '/i.jpg' }] } }).nextCalled, true);
  });

  it('requires quantity and a non-negative unit price for an offer', () => {
    assert.strictEqual(runValidator(validators.validateMakeOffer, { body: {} }).nextCalled, false);
    assert.strictEqual(runValidator(validators.validateMakeOffer, { body: { quantity: 0, unitPrice: -1 } }).nextCalled, false);
    assert.strictEqual(runValidator(validators.validateMakeOffer, { body: { quantity: 3, unitPrice: 12.5 } }).nextCalled, true);
  });
});
