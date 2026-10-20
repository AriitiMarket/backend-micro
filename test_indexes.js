const mongoose = require('mongoose');
const uri = process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_orders$1');
mongoose.connect(uri).then(async () => {
  const Payment = require('/app/commerce-service/src/modules/fulfillment/models/Payments');
  await Payment.init();
  const indexes = await Payment.collection.indexes();
  console.log('Indexes:', JSON.stringify(indexes, null, 2));
  await mongoose.connection.close();
});