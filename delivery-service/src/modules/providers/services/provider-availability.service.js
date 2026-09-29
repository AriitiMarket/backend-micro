const providersRepo = require('../repositories/providers.repository');

async function setOnlineStatus(providerId, isOnline, actor = null) {
  const provider = await providersRepo.findById(providerId);
  if (!provider) throw Object.assign(new Error('Provider not found'), { status: 404 });

  // If a provider is suspended, they cannot go online
  if (isOnline && provider.status === 'suspended') {
    throw Object.assign(new Error('Suspended provider cannot go online'), { status: 403 });
  }

  // Derive new status: 
  // If going online and no active deliveries -> 'available'
  // If going online and active deliveries -> 'busy'
  // If going offline -> 'offline'
  let newStatus = provider.status;
  if (isOnline) {
    if (provider.status === 'offline' || provider.status === 'pending') {
      newStatus = provider.activeDeliveries > 0 ? 'busy' : 'available';
    }
  } else {
    // Going offline
    if (['available', 'busy'].includes(provider.status)) {
      newStatus = 'offline';
    }
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
