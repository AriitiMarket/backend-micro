const mongoose = require('mongoose');

/**
 * Payment Methods Schema
 * Stores user payment methods for orders
 */
const paymentMethodSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  
  methodType: {
    type: String,
    enum: ['CARD', 'MOBILE_WALLET', 'BANK_TRANSFER', 'COD', 'CRYPTO'],
    required: true
  },
  
  // For card payments
  card: {
    last4: String,
    brand: { enum: ['VISA', 'MASTERCARD', 'AMEX'] },
    expiryMonth: Number,
    expiryYear: Number,
    holderName: String,
    tokenized: Boolean,
    stripeTokenId: String,
    paystackAuthorizationUrl: String
  },
  
  // For mobile wallet
  wallet: {
    provider: { enum: ['TELEBIRR', 'CBE', 'DASHEN', 'ABYSINIA'] },
    phoneNumber: String,
    verified: Boolean
  },
  
  // For bank transfer
  bankAccount: {
    bankName: String,
    accountNumber: String,
    accountHolder: String,
    routingNumber: String,
    accountType: { enum: ['CHECKING', 'SAVINGS'] }
  },
  
  // For COD (Cash on Delivery)
  cod: {
    enabled: Boolean,
    availableInAreas: [String]
  },
  
  // For Crypto
  crypto: {
    address: String,
    network: { enum: ['ETHEREUM', 'BITCOIN', 'POLYGON', 'BINANCE'] },
    verified: Boolean
  },
  
  // Common fields
  isDefault: {
    type: Boolean,
    default: false
  },
  
  isVerified: {
    type: Boolean,
    default: false
  },
  
  verifiedAt: Date,
  
  failureCount: {
    type: Number,
    default: 0
  },
  
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED'],
    default: 'ACTIVE'
  },
  
  lastUsed: Date,
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Ensure only one default per user
paymentMethodSchema.index({ userId: 1, isDefault: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
