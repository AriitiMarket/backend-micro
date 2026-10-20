const mongoose = require('mongoose');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');

const paymentsRoutes = require('./src/modules/fulfillment/routes/payments.routes');
const PaymentMethod = require('./src/modules/fulfillment/models/PaymentMethods');
const Order = require('./src/modules/fulfillment/models/Orders');

async function test() {
  await mongoose.connect('mongodb://localhost:27017/ariti_commerce_test_payment_integration');
  
  // Create test app
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => {
    req.fromGateway = true;
    req.user = { id: 'buyer-1', role: 'BUYER' };
    next();
  });
  app.use('/payment', paymentsRoutes);
  
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  
  // Seed order
  const order = await Order.create({
    cart: [{ _id: 'p-1', productId: 'p-1', name: 'Widget', quantity: 1, qty: 1, discountPrice: 5, price: 5, subtotal: 5 }],
    user: { id: 'buyer-1', name: 'Buyer', email: 'b@example.com' },
    buyerId: 'buyer-1',
    subtotal: 5,
    shippingFee: 0,
    currency: 'ETB',
    totalPrice: 5,
    paymentStatus: 'PENDING',
    status: 'PROCESSING',
    sellerId: 'seller-a',
    shopId: 'shop-a',
    sellerShipments: [{
      sellerId: 'seller-a',
      shopId: 'shop-a',
      items: [{ name: 'Widget', quantity: 1, subtotal: 5 }],
      subtotal: 5,
    }],
  });
  
  // Update Telebirr
  await PaymentMethod.updateOne({ key: 'TELEBIRR' }, { status: 'ACTIVE', configured: true, minAmount: 10, availableFor: ['BUYERS'] });
  
  // Test payment creation
  const response = await fetch(`${baseUrl}/payment/create-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: String(order._id), paymentMethod: 'TELEBIRR' }),
  });
  
  const body = await response.json();
  console.log('Status:', response.status);
  console.log('Body:', JSON.stringify(body, null, 2));
  
  await server.close();
  await mongoose.connection.close();
}

test().catch(console.error);
