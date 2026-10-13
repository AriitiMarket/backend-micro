const providersRepo = require('../repositories/providers.repository');
const { availabilityForLoad } = require('./provider-capacity.service');

async function setOnlineStatus(providerId, isOnline, actor = null) {
  const provider = await providersRepo.findById(providerId);
  if (!provider) throw Object.assign(new Error('Provider not found'), { status: 404 });

  // Account status is authoritative: a provider who is not ACTIVE (deactivated,
  // still pending approval, or rejected) has no availability to set. Only the
  // provider/system may ever flip this flag — the Admin UI never does (§7).
  if (isOnline && ['suspended', 'pending', 'rejected'].includes(provider.status)) {
    throw Object.assign(
      new Error(`A ${provider.status} provider cannot go online`),
      { status: 403 },
    );
  }

  // Coming online re-derives the shift from the CURRENT load, using the same
  // rule the capacity service applies: under capacity -> `available`, at
  // capacity -> `busy`. It never uses "has any work" as the test, so toggling
  // online while carrying one delivery does not wrongly mark someone BUSY (and
  // therefore ineligible for the rest of it).
  let newStatus = provider.status;
  if (isOnline && provider.status === 'offline') {
    newStatus = availabilityForLoad(provider);
  } else if (!isOnline && ['available', 'busy'].includes(provider.status)) {
    // Going offline is always the provider's own call.
    newStatus = 'offline';
  }

  const fields = {
    'availability.isOnline': isOnline,
    'availability.lastSeenAt': new Date(),
    status: newStatus
  };

  return providersRepo.updateFields(providerId, fields);
}

async function updateLocation(providerId, coordinates) {
  const provider = await providersRepo.findById(providerId);
  if (!provider) throw Object.assign(new Error('Provider not found'), { status: 404 });

  if (provider.status === 'suspended') {
    throw Object.assign(new Error('Suspended provider cannot update location'), { status: 403 });
  }

  const fields = {
    'availability.currentLocation': { type: 'Point', coordinates }, // [longitude, latitude]
    'availability.lastSeenAt': new Date()
  };
  return providersRepo.updateFields(providerId, fields);
}

module.exports = {
  setOnlineStatus,
  updateLocation
};
