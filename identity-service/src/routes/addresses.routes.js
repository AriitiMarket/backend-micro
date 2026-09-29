// Address management routes — built on top of the existing JSONB addresses array.
const express = require('express');
const router = express.Router();
const addressController = require('../controllers/addresses.controller');
const authenticate = require('../middleware/authenticate');
const { validateCreateAddress } = require('../validators/addresses.validators');

router.get('/address', authenticate, addressController.getAddresses);
router.post('/address', authenticate, validateCreateAddress, addressController.addAddress);
router.put('/address/:id', authenticate, addressController.updateAddress);
router.put('/address/:id/default', authenticate, addressController.setDefaultAddress);
router.delete('/address/:id', authenticate, addressController.deleteAddress);

module.exports = router;