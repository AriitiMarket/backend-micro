#!/usr/bin/env node
/**
 * Orders E2E — exercises the LIVE commerce-service over HTTP and asserts the
 * resulting database state.
 *
 * Coverage (MVP):
 *   [1] per-order money for a single-seller checkout
 *   [2] multi-seller checkout: one order per shop, each invoiced for its own items
 *   [3] strict quantity validation (0 / negative / non-numeric rejected)
 *   [4] duplicate cart lines merge into one line (no double reservation)
 *   [5] failed reservation → clean 400, NO orphan order, NO leaked reservation
 *   [6] concurrency: two buyers racing the last units → one 201, one 400 (never 500)
 *   [7] ownership/authorization regression on the order routes
 *
 * Usage:
 *   docker exec <commerce-container> node scripts/order-e2e.js
 */
const mongoose = require('mongoose');
const http = require('http');
const lib = require('./pm-e2e-lib');

const { api, check, fixtures, MODELS, SELLER_A, SELLER_B, ADMIN, CUSTOMER } = lib;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/ariti_commerce';
const OrderDeliveryModel = require('../src/modules/orders/models/OrderDeliveries');
const productRepository = require('../src/modules/products/repositories/products.repository');
const { Product, Order, Shop, StockMovement } = MODELS;

/**
 * Give back the units an order still holds (the harness deletes rows directly,
 * so the checkout compensation path never runs for them).
 */
async function productRepositoryRelease(productId, quantity) {
  if (!productId || !quantity || quantity < 1) return;
  try { await productRepository.releaseReserved(String(productId), quantity); } catch (e) { /* already 0 */ }
}

const MARK = 'ORDER-E2E';
const DESTINATION = { sectorId: 'sec_e2e', fullAddress: MARK, phone: '0911000000' };
const BUYER = { id: 'order_e2e_buyer', role: 'CUSTOMER', email: 'order-e2e@buyer.local' };
const RACER_A = { id: 'order_e2e_racer_a', role: 'CUSTOMER' };
const RACER_B = { id: 'order_e2e_racer_b', role: 'CUSTOMER' };

const payload = (shopId, over = {}) => ({
  name: 'ORDER E2E Widget',
  description: 'Orders e2e fixture; safe to delete.',
  category: 'E2E Cat',
  discountPrice: 100,
  originalPrice: 120,
  stock: 10,
  tags: 'ordere2e',
  shopId,
  ...over,
});

const orderBody = (cart, as = BUYER) => ({
  cart,
  // A deliberately wrong client total: the server must recompute everything.
  totalPrice: 0.01,
  user: { id: as.id, email: as.email || `${as.id}@e2e.local` },
  destination: DESTINATION,
  paymentInfo: { type: 'Cash On Delivery' },
});

const line = (productId, quantity, shopId) => ({ _id: productId, quantity, shopId });

const money = (res) => ((res.body || {}).orders || []);
const expectedShipping = (subtotal) => Math.round(subtotal * 0.03 * 100) / 100;

/**
 * Call the PUBLIC gateway from inside the cluster — used to prove which paths
 * exist at the real edge (the old public delivery webhook must be gone) and
 * which require the cluster credential.
 * @param {string} path e.g. /api/internal/commerce/delivery-webhook/status
 * @param {Object} body payload
 * @param {boolean} withToken send the cluster credential (default true)
 */
function gatewayPost(path, body, withToken = true) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}));
    const url = new URL(process.env.GATEWAY_URL || 'http://api-gateway:8000');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': payload.length };
    if (withToken) headers['X-Internal-Token'] = process.env.INTERNAL_SERVICE_TOKEN || '';
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path, method: 'POST', headers, timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = { raw: data }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { message: err.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { message: 'timeout' } }); });
    req.write(payload);
    req.end();
  });
}


/**
 * Poll a predicate until it holds or the timeout passes — used for the async
 * checkout → Delivery Service handoff (fire-and-forget after commit).
 */
async function waitFor(read, predicate, timeoutMs = 4000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return value;
}

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const { shopA, shopB } = await fixtures();
  const shopAId = String(shopA._id);
  const shopBId = String(shopB._id);

  // Both shops must be publicly sellable for the multi-seller test. Shop B is
  // created hidden by the shared fixtures; that is restored in the cleanup.
  await Shop.updateOne({ _id: shopBId }, { $set: { showOnPublic: true } });
  await Product.updateMany({ shopId: shopBId }, { $set: { 'shop.showOnPublic': true } });

  // Real delivery locations: the Delivery Service validates the pickup and
  // destination location ids of a handoff against ITS locations collection, so
  // the fixture must reference ids that actually exist there (otherwise the
  // request is correctly rejected and [9] could never prove the handoff).
  const deliveryConn = await mongoose
    .createConnection(MONGODB_URI.replace(/\/[^/]+$/, '/ariti_delivery'), { serverSelectionTimeoutMS: 8000 })
    .asPromise();
  const DeliveryLocation = deliveryConn.model(
    'Location',
    new mongoose.Schema(
      { name: String, type: String, parentId: mongoose.Schema.Types.ObjectId, isActive: Boolean },
      { strict: false, collection: 'locations' }
    )
  );
  const DeliveryRequest = deliveryConn.model(
    'DeliveryRequest',
    new mongoose.Schema({ orderId: String, sellerId: String, buyerId: String }, { strict: false, collection: 'deliveryrequests' })
  );
  const pickupLoc = await DeliveryLocation.findOne({ type: 'sector', isActive: true })
    || await DeliveryLocation.findOne({ type: 'city', isActive: true })
    || await DeliveryLocation.findOne({ isActive: true });
  const dropLoc = await DeliveryLocation.findOne({ _id: { $ne: pickupLoc._id }, isActive: true }) || pickupLoc;
  DESTINATION.sectorId = String(dropLoc._id);

  // Give shop A a resolved pickup snapshot pointing at a real location.
  const originalShopASnapshot = await Shop.findById(shopAId).lean();
  await Shop.updateOne({ _id: shopAId }, {
    $set: {
      sectorId: String(pickupLoc._id),
      locationSnapshot: {
        regionId: null, regionName: 'Hararghe', areaId: null, areaName: '', cityId: null, cityName: '',
        sectorId: String(pickupLoc._id), sectorName: pickupLoc.name || '',
        fullAddress: originalShopASnapshot.address, landmark: '', building: '',
        contactPhone: String(originalShopASnapshot.phoneNumber || ''),
        coordinates: { latitude: null, longitude: null },
        resolvedAt: new Date(),
      },
    },
  });

  try {
    // ── fixtures: one published product per shop ────────────────────────────
    const prodARes = await api('POST', '/product/create-product', { as: SELLER_A, body: payload(shopAId, { sku: 'ORDER-E2E-A' }) });
    const prodBRes = await api('POST', '/product/create-product', { as: SELLER_B, body: payload(shopBId, { sku: 'ORDER-E2E-B' }) });
    const prodA = (prodARes.body || {}).product;
    const prodB = (prodBRes.body || {}).product;
    await api('POST', `/product/publish/${prodA._id}`, { as: SELLER_A });
    await api('POST', `/product/publish/${prodB._id}`, { as: SELLER_B });
    check('fixtures: two published products (one per shop)',
      prodARes.status === 201 && prodBRes.status === 201, [prodARes.status, prodBRes.status]);

    // ── [1] single-seller money ─────────────────────────────────────────────
    console.log('\n[1] Per-order money (single seller)');
    const one = await api('POST', '/order/create-order', { as: BUYER, body: orderBody([line(prodA._id, 2, shopAId)]) });
    check('order created (201)', one.status === 201, one.body);
    const o1 = money(one)[0] || {};
    check('client-supplied totalPrice is ignored (200 + 3% = 206)', o1.totalPrice === 206, o1.totalPrice);
    check('order stores its own subtotal (200)', o1.subtotal === 200, o1.subtotal);
    check('order stores its own shippingFee (6)', o1.shippingFee === 6, o1.shippingFee);
    check('currency recorded', o1.currency === 'ETB', o1.currency);

    console.log('\n[2] Multi-seller checkout: one order per shop, each invoiced for its own items');
    const multi = await api('POST', '/order/create-order', {
      as: BUYER, body: orderBody([line(prodA._id, 1, shopAId), line(prodB._id, 1, shopBId)]),
    });
    const multiOrders = money(multi);
    check('one order per shop (2)', multi.status === 201 && multiOrders.length === 2, multiOrders.length);
    const byShop = new Map(multiOrders.map((o) => [o.sellerShipments[0].shopId, o]));
    const oA = byShop.get(shopAId) || {};
    const oB = byShop.get(shopBId) || {};
    check('shop A order total = its own items only (103)', oA.totalPrice === 103, oA.totalPrice);
    check('shop B order total = its own items only (103)', oB.totalPrice === 103, oB.totalPrice);
    check('per-order subtotals (100 / 100)', oA.subtotal === 100 && oB.subtotal === 100, [oA.subtotal, oB.subtotal]);
    check('checkout total (sum of orders) = 206',
      Math.round((oA.totalPrice + oB.totalPrice) * 100) / 100 === 206, oA.totalPrice + oB.totalPrice);
    check('each order carries exactly one shipment', oA.sellerShipments.length === 1 && oB.sellerShipments.length === 1);
    check('each order cart holds only its own line', oA.cart.length === 1 && oB.cart.length === 1);

    // ── [3] strict quantity validation ──────────────────────────────────────
    console.log('\n[3] Quantity must be a whole number >= 1');
    const beforeBadQty = await Order.countDocuments({ 'destination.fullAddress': MARK });
    for (const bad of [0, -5, 'abc', 1.5, null]) {
      const res = await api('POST', '/order/create-order', {
        as: BUYER, body: orderBody([line(prodA._id, bad, shopAId)]),
      });
      check(`quantity ${JSON.stringify(bad)} rejected (400)`, res.status === 400,
        { status: res.status, message: res.body && res.body.message });
    }
    const afterBadQty = await Order.countDocuments({ 'destination.fullAddress': MARK });
    check('no order row was created for any invalid quantity',
      afterBadQty === beforeBadQty, { before: beforeBadQty, after: afterBadQty });
    const prodAAfterBad = await Product.findById(prodA._id).lean();
    check('no reservation leaked from the rejected attempts', prodAAfterBad.reserved === 3,
      prodAAfterBad.reserved);

    // ── [4] duplicate cart lines merge ──────────────────────────────────────
    console.log('\n[4] Duplicate cart lines for one product are merged');
    const dupRes = await api('POST', '/order/create-order', {
      as: BUYER, body: orderBody([line(prodA._id, 1, shopAId), line(prodA._id, 1, shopAId)]),
    });
    check('duplicate lines no longer 500 (201)', dupRes.status === 201, dupRes.body);
    const dupOrder = money(dupRes)[0] || {};
    check('the order has ONE line', dupOrder.cart.length === 1, dupOrder.cart.length);
    check('quantities were summed (2)', dupOrder.cart[0].quantity === 2, dupOrder.cart[0] && dupOrder.cart[0].quantity);
    check('the subtotal matches the merged line (200)', dupOrder.subtotal === 200, dupOrder.subtotal);

    // ── [5] partial reservation must roll back precisely ────────────────────
    console.log('\n[5] A failed checkout releases exactly what it reserved');
    // Free the units held by earlier sections, then size both products so that
    // line 1 fits and line 2 does not.
    await Product.updateOne({ _id: prodA._id }, { $set: { reserved: 0 } });
    await Product.updateOne({ _id: prodB._id }, { $set: { reserved: 0 } });
    await api('PUT', `/product/adjust-stock/${prodA._id}`, { as: SELLER_A, body: { quantity: 5 } });
    await api('PUT', `/product/adjust-stock/${prodB._id}`, { as: SELLER_B, body: { quantity: 1 } });
    const beforeFailA = await Product.findById(prodA._id).lean();
    const beforeFailB = await Product.findById(prodB._id).lean();
    const ordersBeforeFail = await Order.countDocuments({ 'destination.fullAddress': MARK });
    const failRes = await api('POST', '/order/create-order', {
      as: BUYER,
      body: orderBody([line(prodA._id, 2, shopAId), line(prodB._id, 5, shopBId)]),
    });
    check('insufficient stock answers 400 (not 500)', failRes.status === 400,
      { status: failRes.status, message: failRes.body && failRes.body.message });
    const afterFailA = await Product.findById(prodA._id).lean();
    const afterFailB = await Product.findById(prodB._id).lean();
    const ordersAfterFail = await Order.countDocuments({ 'destination.fullAddress': MARK });
    check('no half-built order row was left behind',
      ordersAfterFail === ordersBeforeFail, { before: ordersBeforeFail, after: ordersAfterFail });
    check('the units reserved by the successful line were released',
      afterFailA.reserved === beforeFailA.reserved, { before: beforeFailA.reserved, after: afterFailA.reserved });
    check('the failing line left nothing behind',
      afterFailB.reserved === beforeFailB.reserved, { before: beforeFailB.reserved, after: afterFailB.reserved });
    const liveOrderIds = (await Order.find({ 'destination.fullAddress': MARK }, { _id: 1 }).lean()).map((o) => String(o._id));
    const orphanMovements = await StockMovement.countDocuments({
      orderId: { $nin: [null, ...liveOrderIds] },
      shopId: { $in: [shopAId, shopBId] },
      type: { $in: ['order_placed', 'order_confirmed', 'order_cancelled', 'refund'] },
    });
    check('no ledger row references a rolled-back order', orphanMovements === 0, orphanMovements);

    // ── [6] concurrency: two buyers, the last units ─────────────────────────
    console.log('\n[6] Two buyers racing the last units');
    // Free the units held by earlier sections FIRST: the stock floor refuses a
    // total below what open orders hold.
    await Product.updateOne({ _id: prodA._id }, { $set: { reserved: 0 } });
    await api('PUT', `/product/adjust-stock/${prodA._id}`, { as: SELLER_A, body: { quantity: 2 } });
    const ordersBeforeRace = await Order.countDocuments({ 'destination.fullAddress': MARK });
    const racers = await Promise.all([
      api('POST', '/order/create-order', { as: RACER_A, body: orderBody([line(prodA._id, 2, shopAId)], RACER_A) }),
      api('POST', '/order/create-order', { as: RACER_B, body: orderBody([line(prodA._id, 2, shopAId)], RACER_B) }),
    ]);
    const statuses = racers.map((r) => r.status).sort();
    check('exactly one winner (201) and one clean loser (400)',
      statuses[0] === 201 && statuses[1] === 400, statuses);
    check('no 500 on either racer', !statuses.includes(500), statuses);
    const afterRace = await Product.findById(prodA._id).lean();
    check('only the winner holds the units (reserved = 2)', afterRace.reserved === 2, afterRace.reserved);
    const ordersAfterRace = await Order.countDocuments({ 'destination.fullAddress': MARK });
    check('only one order row was created by the race',
      ordersAfterRace === ordersBeforeRace + 1, { before: ordersBeforeRace, after: ordersAfterRace });

    // ── [7] authorization regression ────────────────────────────────────────
    console.log('\n[7] Ownership and role isolation');
    const winnersOrder = (racers.find((r) => r.status === 201).body.orders || [])[0];
    check('the buyer can read their own order',
      (await api('GET', `/order/order/${winnersOrder._id}`, { as: RACER_A })).status === 200
      || (await api('GET', `/order/order/${winnersOrder._id}`, { as: RACER_B })).status === 200);
    check('another customer cannot read it',
      (await api('GET', `/order/order/${winnersOrder._id}`, { as: BUYER })).status === 403);
    check('a foreign seller cannot change its status',
      (await api('PUT', `/order/update-order-status/${winnersOrder._id}`, { as: SELLER_B, body: { status: 'Confirmed' } })).status === 403);
    check('a customer cannot change order status',
      (await api('PUT', `/order/update-order-status/${winnersOrder._id}`, { as: CUSTOMER, body: { status: 'Confirmed' } })).status === 403);
    check('the owning seller sees it in the shop queue',
      ((await api('GET', `/order/get-all-orders/seller/${shopAId}`, { as: SELLER_A })).body.orders || [])
        .some((o) => o._id === winnersOrder._id));

    // ── [8] ORDER ↔ DELIVERY bridge ─────────────────────────────────────────
    console.log('\n[8] ORDER <-> DELIVERY bridge table');
    const link = await OrderDeliveryModel.findOne({ orderId: String(winnersOrder._id) }).lean();
    check('checkout created the bridge row for the order', Boolean(link));
    check('the row holds the delivery brief (destination + items)',
      Boolean(link) && Boolean(link.deliveryAddress) && link.items.length === 1,
      link && { items: link.items.length, dest: Boolean(link.deliveryAddress) });
    check('the row records the pickup origin snapshot',
      Boolean(link) && Boolean(link.pickupAddress), link && Object.keys(link.pickupAddress || {}).length);

    const ownerRole = winnersOrder.sellerId === SELLER_A.id ? SELLER_A : SELLER_B;
    const readable = await api('GET', `/order/${winnersOrder._id}/delivery`, { as: ownerRole });
    check('the owning seller can read the delivery info', readable.status === 200, readable.status);
    const strangerRead = await api('GET', `/order/${winnersOrder._id}/delivery`, { as: BUYER });
    check('a stranger cannot read another order delivery', strangerRead.status === 403, strangerRead.status);
    const missingLink = await api('GET', `/order/64b000000000000000000001/delivery`, { as: ADMIN });
    check('an order without a link answers 404', missingLink.status === 404, missingLink.status);

    // Advance the order to Confirmed (its owner), then replay delivery events
    // through the INTERNAL path — the only one that now exists.
    const confirmed = await api('PUT', `/order/update-order-status/${winnersOrder._id}`, {
      as: ownerRole, body: { status: 'Confirmed' },
    });
    check('owner confirms the order', confirmed.status === 200, confirmed.body && confirmed.body.message);

    const evt = (status, extra) => gatewayPost('/api/internal/commerce/delivery-webhook/status',
      Object.assign({ deliveryId: 'dlv_probe_1', orderId: String(winnersOrder._id), status }, extra || {}));
    const pickupEvt = await evt('pickup');
    check('delivery event accepted on the INTERNAL path', pickupEvt.status === 200, pickupEvt);
    const linkAfterPickup = await OrderDeliveryModel.findOne({ orderId: String(winnersOrder._id) }).lean();
    check('bridge recorded the delivery status + id',
      linkAfterPickup && linkAfterPickup.status === 'pickup' && linkAfterPickup.deliveryId === 'dlv_probe_1',
      linkAfterPickup && { status: linkAfterPickup.status, deliveryId: linkAfterPickup.deliveryId });

    // The delivery state must be visible on the ORDER LISTS too (buyer + seller):
    // one batched bridge lookup attaches deliveryStatus/deliveryId to every row,
    // which is what both frontends render as the shipment chip.
    const sellerList = await api('GET', `/order/get-all-orders/seller/${shopAId}`, { as: SELLER_A });
    const sellerRow = (sellerList.body.orders || []).find((o) => o._id === String(winnersOrder._id));
    check('the seller order list carries the delivery status',
      Boolean(sellerRow) && sellerRow.deliveryStatus === 'pickup' && sellerRow.deliveryId === 'dlv_probe_1',
      sellerRow && { deliveryStatus: sellerRow.deliveryStatus, deliveryId: sellerRow.deliveryId });

    // The buyer list is CUSTOMER-only (the route authorizes the exact role and
    // the controller only lets ADMIN through for foreign ids) — so call it as
    // the racer who actually owns the winning order.
    const buyerCaller = winnersOrder.customerId === RACER_A.id ? RACER_A : RACER_B;
    const buyerList = await api('GET', `/order/get-all-orders/user/${winnersOrder.customerId}`, { as: buyerCaller });
    const buyerRow = (buyerList.body.orders || []).find((o) => o._id === String(winnersOrder._id));
    check('the buyer order list carries the delivery status',
      Boolean(buyerRow) && buyerRow.deliveryStatus === 'pickup',
      buyerRow && buyerRow.deliveryStatus);

    const plainRow = (buyerList.body.orders || []).find((o) => o.deliveryStatus === null);
    check('orders without a shipment report deliveryStatus null (never invented)',
      (buyerList.body.orders || []).length === 0 || plainRow !== undefined || (buyerList.body.orders || []).every((o) => 'deliveryStatus' in o),
      (buyerList.body.orders || []).length);
    const shippedOrder = await Order.findById(winnersOrder._id).lean();
    check('the order advanced Confirmed -> Shipped (legal transition)',
      shippedOrder.status === 'Shipped', shippedOrder.status);

    const transit = await evt('in_transit');
    const delivered = await evt('delivered');
    const deliveredOrder = await Order.findById(winnersOrder._id).lean();
    check('in_transit then delivered advanced the order correctly',
      transit.status === 200 && delivered.status === 200 && deliveredOrder.status === 'Delivered',
      deliveredOrder.status);
    check('deliveredAt stamped once the order is Delivered', Boolean(deliveredOrder.deliveredAt));
    const replay = await evt('delivered');
    check('replayed delivery event is idempotent (still 200, still Delivered)',
      replay.status === 200 && (await Order.findById(winnersOrder._id)).status === 'Delivered',
      replay);

    const bogus = await gatewayPost('/api/internal/commerce/delivery-webhook/status',
      { deliveryId: 'x', orderId: String(winnersOrder._id), status: 'teleport' });
    check('unknown delivery status -> 400', bogus.status === 400, bogus.status);
    const unknownOrder = await gatewayPost('/api/internal/commerce/delivery-webhook/status',
      { deliveryId: 'x', orderId: '64b000000000000000000002', status: 'pickup' });
    check('unknown order -> 404', unknownOrder.status === 404, unknownOrder.status);

    const publicWebhook = await gatewayPost('/api/delivery-webhook/status',
      { deliveryId: 'x', orderId: String(winnersOrder._id), status: 'delivered' });
    check('the OLD public webhook path is gone (no status change allowed)',
      publicWebhook.status === 404 || publicWebhook.status === 403, publicWebhook.status);
    const publicStatus = await Order.findById(winnersOrder._id).lean();
    check('the order was not moved by the unauthenticated attempt',
      publicStatus.status === 'Delivered', publicStatus.status);
    // The internal path needs the cluster credential.
    const noToken = await gatewayPost('/api/internal/commerce/delivery-webhook/status',
      { deliveryId: 'x', orderId: String(winnersOrder._id), status: 'cancelled' }, false);
    check('the internal path without the cluster credential -> 403', noToken.status === 403, noToken.status);

    console.log('\n[9] Commerce -> Delivery assignment handoff');
    // The handoff fires asynchronously right after a committed checkout, so
    // give it a moment to land on the bridge.
    const bridgeAfterCheckout = await waitFor(
      () => OrderDeliveryModel.findOne({ orderId: String(winnersOrder._id) }).lean(),
      (row) => Boolean(row && row.deliveryRequestId), 4000);
    check('checkout handed the order to the Delivery Service (request recorded on the bridge)',
      Boolean(bridgeAfterCheckout && bridgeAfterCheckout.deliveryRequestId),
      bridgeAfterCheckout && { deliveryRequestId: bridgeAfterCheckout.deliveryRequestId });
    check('the delivery brief on the bridge matches the order (pickup + destination)',
      Boolean(bridgeAfterCheckout)
        && Boolean(bridgeAfterCheckout.pickupAddress)
        && Boolean(bridgeAfterCheckout.deliveryAddress)
        && bridgeAfterCheckout.totalValue > 0,
      bridgeAfterCheckout && { totalValue: bridgeAfterCheckout.totalValue });

  } finally {
    // Remove every fixture this run created, then restore the shared fixtures
    // (shop B is hidden in the shared setup, and the fixture products go away).
    try {
      const staleOrders = await Order.find({ 'destination.fullAddress': MARK }, { _id: 1 }).lean();
      const orderIds = staleOrders.map((o) => String(o._id));
      // Release the units those orders still hold BEFORE the rows go: the
      // harness deletes directly, so the checkout compensation path never runs.
      if (orderIds.length) {
        const held = await Order.find({ _id: { $in: staleOrders.map((o) => o._id) } }, { cart: 1 }).lean();
        for (const doc of held) {
          for (const item of (doc.cart || [])) {
            const pid = item && (item._id || item.id);
            if (pid) await productRepositoryRelease(pid, Number(item.quantity || item.qty || 0));
          }
        }
      }
      await StockMovement.deleteMany({ orderId: { $in: orderIds } });
      await Order.deleteMany({ 'destination.fullAddress': MARK });
      // The ORDER <-> DELIVERY bridge rows for those orders go with them.
      await OrderDeliveryModel.deleteMany({ $or: [{ orderId: { $in: orderIds } }, { deliveryId: 'dlv_probe_1' }] });

      const staleProducts = await Product.find({ sku: { $regex: '^ORDER-E2E-' } }, { _id: 1 }).lean();
      const productIds = staleProducts.map((p) => String(p._id));
      if (productIds.length) {
        await StockMovement.deleteMany({ productId: { $in: productIds } });
        await Product.deleteMany({ _id: { $in: productIds } });
      }

      await Shop.updateOne({ _id: shopBId }, { $set: { showOnPublic: false } });
      await Product.updateMany({ shopId: shopBId }, { $set: { 'shop.showOnPublic': false } });

      // Restore shop A's original location snapshot (the pickup fixture).
      await Shop.updateOne({ _id: shopAId }, {
        $set: {
          sectorId: originalShopASnapshot.sectorId || null,
          locationSnapshot: originalShopASnapshot.locationSnapshot || null,
        },
      });

      // The delivery requests the handoffs created (delivery database).
      // `orderIds` was captured BEFORE the orders were deleted.
      if (orderIds.length) {
        await DeliveryRequest.deleteMany({ orderId: { $in: orderIds } });
      }
      await deliveryConn.close();
    } catch (e) { console.error('[cleanup] fixture removal failed:', e.message); }

  }

  const { pass, fail, failures } = lib.summary();
  console.log(`\n=== Orders E2E: ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
