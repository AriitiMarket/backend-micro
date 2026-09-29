const mongoose = require('mongoose');

const providerSchema = new mongoose.Schema({
  identityUserId: { type: String, default: null },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  email: { type: String, default: null, trim: true },
  status: { type: String, default: 'pending', enum: ['pending', 'available', 'busy', 'offline', 'suspended'] },
  /**
   * Business model of the delivery provider.
   *
   * This is deliberately separate from `actorType`: `actorType` is the
   * transport role a provider fills (rider / driver / courier / pickup agent),
   * while `providerType` says what KIND of provider they are. One provider is a
   * single entity in the admin UI ("Delivery Provider") carrying both.
   */
  providerType: {
    type: String,
    default: 'individual_rider',
    enum: ['individual_rider', 'delivery_business', 'logistics_partner'],
  },
  actorType: { type: String, default: 'rider', enum: ['rider', 'driver', 'courier', 'pickup_agent'] },
  availability: {
    isOnline: { type: Boolean, default: false },
    currentLocation: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    lastSeenAt: { type: Date, default: null },
  },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  zoneIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Zone' }],
  hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hub', default: null },
  vehicleType: { type: String, default: 'bicycle', enum: ['bicycle', 'motorcycle', 'car', 'van', 'truck', 'foot'] },
  plateNumber: { type: String, default: '', trim: true },
  maxCapacityKg: { type: Number, default: 10 },
  // Max concurrent active multi-order assignments this rider may hold.
  maxActiveAssignments: { type: Number, default: 3, min: 1 },
  activeDeliveries: { type: Number, default: 0 },
  currentWorkloadIds: [{ type: String }],
  completedDeliveries: { type: Number, default: 0 },
  rating: { type: Number, default: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

providerSchema.index({ status: 1 });
providerSchema.index({ providerType: 1 });
providerSchema.index({ 'availability.isOnline': 1 });
providerSchema.index({ serviceId: 1 });
providerSchema.index({ sectorId: 1 });
providerSchema.index({ zoneId: 1 });
providerSchema.index({ zoneIds: 1 });
providerSchema.index({ hubId: 1 });
providerSchema.index({ identityUserId: 1 }, { sparse: true });
providerSchema.index({ 'availability.currentLocation': '2dsphere' }, { sparse: true });

// Collection pinned explicitly: mongoose would otherwise pluralize the model
// name itself, and the pre-rename collection is called `partners` (renamed in
// place by the boot migration in src/app/config/database.js).
module.exports = mongoose.model('Provider', providerSchema, 'providers');
