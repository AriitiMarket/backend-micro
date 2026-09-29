// Customer profile controller — thin HTTP layer over users.service.
const usersService = require('../services/users.service');
const usersRepository = require('../repositories/users.repository');
const { ok } = require('../utils/response');
const { resolveAvatar } = require('../config/imageRefs');

async function getUserInfo(req, res, next) {
  try {
    const user = await usersService.getUserInfo({ userId: req.params.id });
    return ok(res, { user: user });
  } catch (err) {
    return next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const user = await usersService.updateProfile({
      userId: req.user.id,
      name: req.body.name,
      email: req.body.email,
      phoneNumber: req.body.phoneNumber,
    });
    return ok(res, { user: user });
  } catch (err) {
    return next(err);
  }
}

async function updatePassword(req, res, next) {
  try {
    const user = await usersService.updatePassword({
      userId: req.user.id,
      oldPassword: req.body.oldPassword,
      newPassword: req.body.newPassword,
      confirmPassword: req.body.confirmPassword,
    });
    return ok(res, { user: user });
  } catch (err) {
    return next(err);
  }
}

async function updateAddress(req, res, next) {
  try {
    const user = await usersService.updateAddress({
      userId: req.user.id,
      addressData: {
        country: req.body.country,
        city: req.body.city,
        address1: req.body.address1,
        address2: req.body.address2,
        zipCode: req.body.zipCode,
        addressType: req.body.addressType,
      },
    });
    return ok(res, { user: user });
  } catch (err) {
    return next(err);
  }
}

async function removeUserAddress(req, res, next) {
  try {
    const user = await usersService.removeAddress({ userId: req.user.id, addressId: req.params.id });
    return ok(res, { user: user });
  } catch (err) {
    return next(err);
  }
}

async function updateAvatar(req, res, next) {
  try {
    // File upload wins; otherwise accept an external URL or a real storage key.
    const avatar = resolveAvatar(req);
    if (!avatar) {
      return res.status(400).json({
        success: false, code: 'VALIDATION_ERROR',
        message: 'Please upload an image or provide an image URL / storage key',
        errors: [],
      });
    }
    const user = await usersService.updateAvatar({
      userId: req.user.id,
      publicId: avatar.publicId,
      url: avatar.url,
    });
    return ok(res, { user: user });
  } catch (err) {
    return next(err);
  }
}

// Internal (service-to-service) platform user aggregates — used by Commerce to
// build the platform admin dashboard without reading Identity's database.
async function countUsers(req, res, next) {
  try {
    const counts = await usersRepository.counts();
    return ok(res, { counts });
  } catch (err) {
    return next(err);
  }
}

// Internal (service-to-service) lookup by email. Used by Commerce's admin shop
// list to resolve an "owner email" filter into an identity id, so the filter
// narrows the query instead of being ignored.
async function findUserByEmail(req, res, next) {
  try {
    const email = String(req.params.email || '').trim();
    const user = email ? await usersRepository.findByEmailInsensitive(email) : null;
    // A miss is an answer, not an error: the caller turns it into "no match".
    return ok(res, { user: user || null });
  } catch (err) {
    return next(err);
  }
}

// Internal (service-to-service) membership status check. Used by Commerce and
// Delivery services to check if a user has a specific role membership and its status.
async function checkMembershipStatus(req, res, next) {
  try {
    const userId = req.params.id;
    const role = req.params.role;
    const userRolesRepo = require('../repositories/user-roles.repository');
    
    const memberships = await userRolesRepo.listForUser(userId);
    const membership = memberships.find(m => String(m.role).toUpperCase() === String(role).toUpperCase());
    
    if (membership) {
      return ok(res, {
        userId,
        role: membership.role,
        status: membership.status,
        source: membership.source,
        grantedAt: membership.grantedAt,
        updatedAt: membership.updatedAt,
      });
    }
    
    // No membership found
    return ok(res, {
      userId,
      role,
      status: null,
      message: 'No membership found for this role',
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getUserInfo,
  updateProfile,
  updatePassword,
  updateAddress,
  removeUserAddress,
  updateAvatar,
  countUsers,
  findUserByEmail,
  checkMembershipStatus,
};
