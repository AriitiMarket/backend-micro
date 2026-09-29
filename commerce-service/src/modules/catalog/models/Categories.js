const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  title:       { type: String, required: true, unique: true, trim: true },
  slug:        { type: String, unique: true, lowercase: true },
  description: { type: String, default: '' },
  type:        { type: String, enum: ['product', 'business', 'shop', 'event'], required: true, default: 'product' },
  status:      { type: String, enum: ['active', 'inactive'], default: 'active' },
    sortOrder:   { type: Number, default: 0 },
  categoryImage: { type: String, default: null },
  createdAt:   { type: Date, default: Date.now },
});

categorySchema.pre('save', function (next) {
  if (!this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

categorySchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update.title && !update.slug) {
    update.slug = update.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

module.exports = mongoose.model('Category', categorySchema);
