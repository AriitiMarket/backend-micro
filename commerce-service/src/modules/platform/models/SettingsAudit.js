const mongoose = require('mongoose');

const settingsAuditSchema = new mongoose.Schema({
  key: { type: String, required: true, index: true }, // e.g., 'platform'
  field: { type: String, required: true, index: true }, // e.g., 'commissionRate'
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  changedBy: { type: String, description: 'Admin user ID who made the change' },
  changedByRole: { type: String, enum: ['ADMIN', 'SUPER_ADMIN', 'SYSTEM'], default: 'ADMIN' },
  changedAt: { type: Date, default: Date.now, index: true },
  ipAddress: { type: String },
  userAgent: { type: String },
}, {
  timestamps: false,
  collection: 'settings_audit',
  strict: false,
});

settingsAuditSchema.index({ key: 1, field: 1, changedAt: -1 });

module.exports = mongoose.model('SettingsAudit', settingsAuditSchema);
