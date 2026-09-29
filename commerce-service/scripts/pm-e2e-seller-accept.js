#!/usr/bin/env node
/**
 * Seller "accept order" E2E — reproduces the reported bug and verifies the fix.
 *
 * The bug: sellers were dropped on the 404 page when opening an order, and even
 * once the page loaded, accepting it was rejected — orders were stored as
 * 'PENDING' (creation) and 'CONFIRMED' (payment claim), neither of which exists
 * in the order state machine, so canTransition() refused every move and the
 * seller could never accept an order.
 *
 * Usage (inside the commerce-service container):
 *   docker compose exec -T commerce-service node scripts/pm-e2e-seller-accept.js
 */
const mongoose = require('mongoose');
const { api, check, fixtures, MODELS, SELLER_A, SELLER_B, CUSTOMER, summary } = require('./pm-e2e-lib');

const { Product, Order } = MODELS;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/ariti_commerce';

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const { shopA } = await fixtures();
  const shopAId = String(shopA._id);

  console.log('\n[1] A freshly created order enters the state machine at "Processing"');
  const product = await Product.findOneAndUpdate(
    { shopId: shopAId, name: 'E2E Acceptable Widget' },
    {
      $set: {
        name: 'E2E Acceptable Widget', description: 'e2e order-accept fixture',
        category: 'E2E Cat', discountPrice: 100, stock: 20, reserved: 0, sold_out: 0,
        status: 'PUBLISHED', isActive: true, shopId: shopAId, sellerId: SELLER_A.id,
        images: ['https://example.com/e2e.png'],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const productId = String(product._id);

  const created = await api('POST', '/order/create-order', {
    as: CUSTOMER,
    body: {
      cart: [{
        _id: productId, quantity: 1, discountPrice: 0.01, name: 'E2E Acceptable Widget',
        description: 'x', category: 'E2E Cat', images: [], shopId: shopAId,
      }],
      totalPrice: 0.01,
      user: { id: CUSTOMER.id, email: CUSTOMER.email },
      destination: { sectorId: 'e2e-sector', fullAddress: 'E2E street 1', phone: '0911000000' },
      paymentInfo: { type: 'Cash On Delivery' },
    },
  });
  const first = (created.body || {}).orders && created.body.orders[0];
  check('order created', created.status === 200 || created.status === 201, created.body);
  check('new order status is canonical "Processing" (was "PENDING")', first && first.status === 'Processing', first && first.status);

  const orderId = first && String(first._id);

  console.log('\n[2] Seller accepts the order (the reported flow)');
  const accept = await api('PUT', `/order/update-order-status/${orderId}`, {
    as: SELLER_A, body: { status: 'Confirmed' },
  });
  check('accept Processing -> Confirmed returns 200', accept.status === 200, accept.body);
  check('status persisted as "Confirmed"', accept.body && accept.body.order && accept.body.order.status === 'Confirmed', accept.body && accept.body.order && accept.body.order.status);

  console.log('\n[3] The seller queue returns the order with its canonical status');
  const list = await api('GET', `/order/get-all-orders/seller/${SELLER_A.id}`, { as: SELLER_A });
  const listed = ((list.body || {}).orders || []).find((o) => String(o._id) === orderId);
  check('seller order list contains the order', Boolean(listed), list.status);
  console.log('\n[4] The accepted order moves down the canonical chain');
  const ship = await api('PUT', `/order/update-order-status/${orderId}`, { as: SELLER_A, body: { status: 'Shipped' } });
  check('Confirmed -> Shipped returns 200', ship.status === 200, ship.body);
  const transit = await api('PUT', `/order/update-order-status/${orderId}`, { as: SELLER_A, body: { status: 'In Transit' } });
  check('Shipped -> In Transit returns 200', transit.status === 200, transit.body);
  const delivered = await api('PUT', `/order/update-order-status/${orderId}`, { as: SELLER_A, body: { status: 'Delivered' } });
  check('In Transit -> Delivered returns 200', delivered.status === 200, delivered.body);
  check('deliveredAt was stamped', Boolean(delivered.body && delivered.body.order && delivered.body.order.deliveredAt));

  console.log('\n[5] The transition guard is still intact');
  const skip = await api('PUT', `/order/update-order-status/${orderId}`, { as: SELLER_A, body: { status: 'Processing' } });
  check('Delivered -> Processing rejected (400, no backwards move)', skip.status === 400, skip.status);

  console.log('\n[6] Orders already stored as "PENDING" (legacy rows) can be accepted');
  await Order.updateOne({ _id: orderId }, { $set: { status: 'PENDING' } });
  const legacyAccept = await api('PUT', `/order/update-order-status/${orderId}`, { as: SELLER_A, body: { status: 'Confirmed' } });
  check('legacy PENDING order accepts -> 200', legacyAccept.status === 200, legacyAccept.body);
  check('legacy accept is stored canonically as "Confirmed"', legacyAccept.body && legacyAccept.body.order && legacyAccept.body.order.status === 'Confirmed', legacyAccept.body && legacyAccept.body.order && legacyAccept.body.order.status);

  console.log('\n[7] Orders already stored as "CONFIRMED" keep moving');
  await Order.updateOne({ _id: orderId }, { $set: { status: 'CONFIRMED' } });
  const legacyShip = await api('PUT', `/order/update-order-status/${orderId}`, { as: SELLER_A, body: { status: 'Shipped' } });
  check('legacy CONFIRMED order ships -> 200', legacyShip.status === 200, legacyShip.body);

  console.log('\n[8] Another seller still cannot touch this order');
  const foreign = await api('PUT', `/order/update-order-status/${orderId}`, {
    as: SELLER_B, body: { status: 'Delivered' },
  });
  check('foreign seller -> 403', foreign.status === 403, foreign.status);

    // Delete orders directly (the harness does not use the API), so reclaim the
  // ORDER <-> DELIVERY bridge rows they own first.
  const stale = await Order.find({ customerId: CUSTOMER.id }, { _id: 1 }).lean();
  await MODELS.OrderDelivery.deleteMany({ orderId: { $in: stale.map((o) => String(o._id)) } });
  await Order.deleteMany({ customerId: CUSTOMER.id });

  const { pass, fail } = summary();
  console.log(`\n=== Seller accept-order E2E: ${pass} passed, ${fail} failed ===`);
  await mongoose.connection.close();
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('E2E crashed:', err && err.message ? err.message : err);
  process.exit(1);
});

