const mongoose = require('mongoose');
const uri = process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_orders$1');
mongoose.connect(uri).then(async () => {
  const Payment = require('/app/commerce-service/src/modules/fulfillment/models/Payments');
  await Payment.init();
  await Payment.deleteMany({});
  
  // Create a payment
  const payment1 = await Payment.create({
    orderId: 'test-order-1',
    userId: 'user-1',
    sellerId: 'seller-1',
    paymentMethod: 'COD',
    amount: 100,
    currency: 'ETB',
    status: 'PENDING',
  });
  console.log('Created payment:', payment1._id);
  
  // Try to find by order
  const existing = await Payment.findOne({ orderId: 'test-order-1' });
  console.log('Found existing:', existing ? existing._id : 'null');
  
  // Try to create another payment for the same order
  try {
    const payment2 = await Payment.create({
      orderId: 'test-order-1',
      userId: 'user-1',
      sellerId: 'seller-1',
      paymentMethod: 'COD',
      amount: 100,
      currency: 'ETB',
      status: 'PENDING',
    });
    console.log('Created duplicate payment:', payment2._id);
  } catch (e) {
    console.log('Duplicate error:', e.message);
  }
  
  await mongoose.connection.close();
});