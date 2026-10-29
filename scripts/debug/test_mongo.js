const mongoose = require('mongoose');
const uri = process.env.MONGODB_URI;
console.log('Original URI:', uri);

mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log('connected to aritii');
    return mongoose.connection.close();
  })
  .then(() => {
    console.log('closed');
    process.exit(0);
  })
  .catch(e => {
    console.error('error:', e.message);
    process.exit(1);
  });