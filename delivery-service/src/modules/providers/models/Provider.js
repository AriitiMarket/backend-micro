const mongoose = require('mongoose');

const providerSchema = new mongoose.Schema({
  identityUserId: { type: String, default: null },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  email: { type: String, default: null, trim: true },
  // `pending` = application under review; `rejected` = terminal review outcome
  // (the applicant may re-apply); `suspended` = an approved provider taken off
  // the platform. They used to be conflated: rejection wrote `suspended`, which
  // both hid the real outcome and blocked the applicant from ever re-applying.
  status: { type: String, default: 'pending', enum: ['pending', 'available', 'busy', 'offline', 'suspended', 'rejected'] },
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
  // Operating location: City -> Zone -> Port. `cityId` is the city the provider
  // normally works from; zoneIds/portId are the coverage area and local point
  // inside it (chosen at creation / application review, not per-assignment).
  cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  zoneIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Zone' }],
  portId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
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
providerSchema.index({ zoneId: 1 });
providerSchema.index({ zoneIds: 1 });
providerSchema.index({ portId: 1 });
// One application per identity account. A plain unique index would break on the
// many admin-created providers whose `identityUserId` is null, so the index is
// partial: only real account ids must be unique. Named explicitly because it
// replaces the legacy non-unique sparse index of the same key (dropped by the
// boot migration) — reusing the old name would collide with its options.
providerSchema.index(
  { identityUserId: 1 },
  {
    name: 'identityUserId_unique_account',
    unique: true,
    partialFilterExpression: { identityUserId: { $type: 'string' } },
  }
);
providerSchema.index({ 'availability.currentLocation': '2dsphere' }, { sparse: true });

// Collection pinned explicitly: mongoose would otherwise pluralize the model
// name itself, and the pre-rename collection is called `partners` (renamed in
// place by the boot migration in src/app/config/database.js).
const Provider = mongoose.model('Provider', providerSchema, 'providers');

// A failed index build (e.g. duplicate identityUserId in existing data) must be
// a loud warning, not a boot crash: mongoose emits an unhandled 'error' event
// on the model, which otherwise takes the service down.
Provider.on('error', (err) => {
  console.error('[delivery] Provider index warning:', err.message);
});

module.exports = Provider;
