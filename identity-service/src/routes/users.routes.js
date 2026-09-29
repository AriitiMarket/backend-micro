// Customer profile routes.
const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller');
const authenticate = require('../middleware/authenticate');
const internalOnly = require('../middleware/internalOnly');
const { uploadImageFile } = require('../config/upload');
const { validateUpdateProfile, validateUpdatePassword, validateUpdateAddress } = require('../validators/auth.validators');
const validateUuidParam = require('../middleware/validateUuidParam');

// Service-to-service aggregate (cluster credential only — never a browser call).
router.get('/internal/users/count', internalOnly, usersController.countUsers);
// Service-to-service email lookup (cluster credential only). Two segments after
// `/internal/users/` so it can never be read as the `:id` route below.
router.get('/internal/users/by-email/:email', internalOnly, usersController.findUserByEmail);
// Service-to-service membership status check (cluster credential only).
router.get('/internal/users/:id/membership/:role', internalOnly, usersController.checkMembershipStatus);

// Public profile lookup by internal user id. The id is a UUID, so a malformed
// value must be a 400 rather than a database-level 500.
router.get('/user/user-info/:id', validateUuidParam('id'), usersController.getUserInfo);
router.put('/user/update-user-info', authenticate, validateUpdateProfile, usersController.updateProfile);
router.put('/user/update-user-password', authenticate, validateUpdatePassword, usersController.updatePassword);
router.put('/user/update-user-addresses', authenticate, validateUpdateAddress, usersController.updateAddress);
router.delete('/user/delete-user-address/:id', authenticate, usersController.removeUserAddress);
router.put('/user/update-avatar', authenticate, uploadImageFile, usersController.updateAvatar);

module.exports = router;
