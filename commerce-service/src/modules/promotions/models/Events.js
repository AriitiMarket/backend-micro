const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Please enter your event product name!'] },
  description: { type: String, required: [true, 'Please enter your event product description!'] },
  category: { type: String, required: [true, 'Please enter your event product category!'] },
  // Canonical camelCase date fields (consistent with the rest of the codebase).
  // The legacy snake_case aliases are kept as virtuals below so existing
  // documents and any stray references to `start_Date`/`Finish_Date` keep working.
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, default: 'Running' },
  tags: { type: String },
  originalPrice: { type: Number },
  discountPrice: { type: Number, required: [true, 'Please enter your event product price!'] },
  stock: { type: Number, required: [true, 'Please enter your event product stock!'] },
  images: [{ public_id: { type: String }, url: { type: String } }],
  shopId: { type: String, required: true },
  shop: { type: Object, required: true },
  sold_out: { type: Number, default: 0 },
  // Curation flags (optional; default to "visible"/"normal" so listings are
  // never emptied when the flags are absent — see publicContentService).
  showOnPublic: { type: Boolean, default: true },
  featured: { type: Boolean, default: false },
  displayPriority: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// Backward-compatible aliases for the legacy snake_case field names.
// These map reads/writes of `start_Date` -> `startDate` and `Finish_Date` -> `endDate`.
eventSchema.virtual('start_Date').get(function () { return this.startDate; });
eventSchema.virtual('start_Date').set(function (v) { this.startDate = v; });
eventSchema.virtual('Finish_Date').get(function () { return this.endDate; });
eventSchema.virtual('Finish_Date').set(function (v) { this.endDate = v; });

// Expose virtuals (e.g. the aliases above) in toJSON / queries.
eventSchema.set('toJSON', { virtuals: true });
eventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Event', eventSchema);
