#!/usr/bin/env node
/**
 * Product Management E2E — exercises the LIVE commerce-service over HTTP while
 * asserting the resulting database state.
 *
 * Coverage: lifecycle (create→draft→publish), the three admin-curated public
 * gates (isActive kill-switch, seller publish/draft, shop showOnPublic), the
 * admin shop toggle + its product cascade, category public curation, inventory
 * (restock/adjust/ledger), order re-pricing + per-line quantity + reservation,
 * payment-confirmation idempotency, cancel-after-confirm restock, availability
 * gating, search gating and the /shop/getseller resolution contract.
 *
 * Usage:
 *   docker exec <commerce-container> node /app/scripts/pm-e2e.js
 *   # or locally: MONGODB_URI=... PORT=8002 INTERNAL_SERVICE_TOKEN=... node scripts/pm-e2e.js
 */
const http = require('http');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 8002;
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/ariti_commerce';

const SELLER_A = { id: 'e2e_seller_a', role: 'SELLER', email: 'pm-e2e-a@shop.local' };
const SELLER_B = { id: 'e2e_seller_b', role: 'SELLER', email: 'pm-e2e-b@shop.local' };
const ADMIN = { id: 'e2e_admin', role: 'ADMIN', email: 'pm-e2e-admin@aritii.local' };
const CUSTOMER = { id: 'e2e_customer', role: 'CUSTOMER', email: 'pm-e2e-customer@buyer.local' };

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \u2717 ${name}${extra === undefined ? '' : ' \u2192 ' + JSON.stringify(extra)}`);
  }
}

function api(method, path, { body, as } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'X-Internal-Token': TOKEN };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (as) {
      headers['x-user-id'] = as.id;
      headers['x-user-role'] = as.role;
      if (as.email) headers['x-user-email'] = as.email;
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = { raw: data }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const MODELS = {
  Category: require('../src/modules/categories/models/Categories'),
  Shop: require('../src/modules/shops/models/Shops'),
  Product: require('../src/modules/products/models/Products'),
  Order: require('../src/modules/orders/models/Orders'),
  StockMovement: require('../src/modules/products/models/StockMovements'),
  OrderDelivery: require('../src/modules/orders/models/OrderDeliveries'),
};

async function fixtures() {
  const { Category, Shop, Product, Order, StockMovement } = MODELS;
  await Category.updateOne(
    { title: 'E2E Cat', type: 'product' },
    { $set: { title: 'E2E Cat', type: 'product', status: 'active', slug: 'e2e-cat', description: 'e2e' } },
    { upsert: true }
  );
  await Category.updateOne(
    { title: 'E2E Hidden Cat', type: 'product' },
    { $set: { title: 'E2E Hidden Cat', type: 'product', status: 'inactive', slug: 'e2e-hidden-cat' } },
    { upsert: true }
  );

  const shopDefaults = {
    address: 'E2E Street', phoneNumber: 911000000, zipCode: 1000,
    avatar: { public_id: 'e2e', url: 'https://example.com/e2e.png' },
    status: 'APPROVED', role: 'Seller',
  };
  const shopA = await Shop.findOneAndUpdate(
    { ownerId: SELLER_A.id },
    { $set: { ...shopDefaults, ownerId: SELLER_A.id, name: 'PM-E2E Shop A', email: SELLER_A.email, showOnPublic: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const shopB = await Shop.findOneAndUpdate(
    { ownerId: SELLER_B.id },
    { $set: { ...shopDefaults, ownerId: SELLER_B.id, name: 'PM-E2E Shop B', email: SELLER_B.email, showOnPublic: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const shopIds = [String(shopA._id), String(shopB._id)];
  await Product.deleteMany({ shopId: { $in: shopIds } });
  await StockMovement.deleteMany({ shopId: { $in: shopIds } });
  const staleOrders = await Order.find({ customerId: CUSTOMER.id }, { _id: 1 }).lean();
  await Order.deleteMany({ customerId: CUSTOMER.id });
  // ORDER <-> DELIVERY bridge rows for any order removed above (the fixture
  // deletes directly, so the checkout compensation path never runs for them).
  const OrderDelivery = require('../src/modules/orders/models/OrderDeliveries');
  await OrderDelivery.deleteMany({
    $or: [
      { orderId: { $in: staleOrders.map((o) => String(o._id)) } },
      { deliveryId: 'dlv_probe_1' },
    ],
  });
  return { shopA, shopB };
}

module.exports = { api, check, fixtures, MODELS, SELLER_A, SELLER_B, ADMIN, CUSTOMER, summary: () => ({ pass, fail, failures }) };
