// Address business logic — built on the existing JSONB addresses array on the users table.
const usersRepository = require('../repositories/users.repository');

async function getAllAddresses(userId) {
  const user = await usersRepository.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  return user.addresses || [];
}

async function addAddress(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  const addresses = Array.isArray(user.addresses) ? user.addresses.slice() : [];
  if (addresses.length >= 10) {
    const err = new Error('Maximum of 10 addresses per user reached');
    err.statusCode = 400;
    throw err;
  }
  const addressData = {
    ...(payload.addressData || {}),
    _id: require('crypto').randomUUID(),
  };
  // If this is the first address or marked default, reset others and set this as default.
  if (addressData.isDefault === true || addresses.length === 0) {
    addresses.forEach(function (addr) { addr.isDefault = false; });
    addressData.isDefault = true;
  } else {
    addressData.isDefault = false;
  }
  addresses.push(addressData);
  return usersRepository.setAddresses({ id: payload.userId, addresses });
}

async function updateAddress(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  let addresses = Array.isArray(user.addresses) ? user.addresses.slice() : [];
  const idx = addresses.findIndex(function (addr) {
    return String(addr._id) === String(payload.addressId);
  });
  if (idx === -1) {
    const err = new Error('Address not found');
    err.statusCode = 404;
    throw err;
  }
  const merged = { ...addresses[idx], ...(payload.addressData || {}) };
  if (merged.isDefault === true) {
    addresses.forEach(function (addr) { addr.isDefault = false; });
  }
  merged.isDefault = merged.isDefault === true || (addresses.length === 0);
  addresses[idx] = merged;
  return usersRepository.setAddresses({ id: payload.userId, addresses });
}

async function deleteAddress(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  let addresses = Array.isArray(user.addresses) ? user.addresses.slice() : [];
  const wasDefault = addresses.some(function (addr) {
    return String(addr._id) === String(payload.addressId) && addr.isDefault === true;
  });
  const kept = addresses.filter(function (addr) {
    return String(addr._id) !== String(payload.addressId);
  });
  if (wasDefault && kept.length > 0 && !kept.some((a) => a.isDefault)) {
    kept[0].isDefault = true;
  }
  return usersRepository.setAddresses({ id: payload.userId, addresses: kept });
}

async function setDefaultAddress(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  let addresses = Array.isArray(user.addresses) ? user.addresses.slice() : [];
  let found = false;
  addresses.forEach(function (addr) {
    if (String(addr._id) === String(payload.addressId)) {
      addr.isDefault = true;
      found = true;
    } else {
      addr.isDefault = false;
    }
  });
  if (!found) {
    const err = new Error('Address not found');
    err.statusCode = 404;
    throw err;
  }
  return usersRepository.setAddresses({ id: payload.userId, addresses });
}

module.exports = {
  getAllAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};