// Customer profile and address business logic.
const usersRepository = require('../repositories/users.repository');
const passwordUtils = require('../utils/password');

async function getProfile(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode =404;
    throw err;
  }
  return user;
}

async function getUserInfo(payload) {
  return getProfile(payload);
}

async function updateProfile(payload) {
  const fields = {};
  if (payload.name) {
    fields.name = payload.name;
  }
  if (payload.email) {
    fields.email = payload.email;
  }
  if (payload.phoneNumber !== null) {
    fields.phone_number = payload.phoneNumber;
  }
  return usersRepository.updateFields({ id: payload.userId, fields: fields });
}

async function updatePassword(payload) {
  const row = await usersRepository.findByIdForAuth(payload.userId);
  if (!row) {
    const err = new Error('User not found');
    err.statusCode =404;
    throw err;
  }
  const valid = await passwordUtils.comparePassword(payload.oldPassword, row.password_hash);
  if (!valid) {
    const err = new Error('Old password is incorrect');
    err.statusCode =400;
    throw err;
  }
  if (payload.newPassword !== payload.confirmPassword) {
    const err = new Error('Passwords do not match');
    err.statusCode =400;
    throw err;
  }
  const hash = await passwordUtils.hashPassword(payload.newPassword);
  return usersRepository.updatePassword({ id: payload.userId, hash: hash });
}

async function updateAddress(payload) {
  const user = await usersRepository.findById(payload.userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode =404;
    throw err;
  }
  let addresses = [];
  let stash = user.addresses;
  let isArrayAddress = false;
  if (stash) {
  isArrayAddress = (stash !== null && typeof stash === 'object');
  }
  if (isArrayAddress) {
    addresses = stash.slice();
  }
  let idx = -1;
  addresses.forEach(function (addr) {
    if (idx === -1 && addr.addressType === payload.addressData.addressType) {
      idx = addresses.indexOf(addr);
    }
  });
  if (idx > -1) {
    addresses[idx] = payload.addressData;
  } else {
    addresses.push(payload.addressData);
  }
  return usersRepository.setAddresses({ id: payload.userId, addresses: addresses });
}

async function removeAddress(payload) {
  return usersRepository.removeAddress({ id: payload.userId, addressId: payload.addressId });
}

async function updateAvatar(payload) {
  return usersRepository.updateAvatar({ id: payload.userId, publicId: payload.publicId, url: payload.url });
}

module.exports = {
  getProfile,
  getUserInfo,
  updateProfile,
  updatePassword,
  updateAddress,
  removeAddress,
  updateAvatar,
};
