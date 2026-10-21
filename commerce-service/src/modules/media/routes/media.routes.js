// Media routes — standalone image uploads.
//
// Seller/Admin only: these uploads back product and shop galleries. The
// endpoint is separate from product create/update so a client can upload a
// file first, receive a URL, and then reference it in any imageUrls list.
const express = require('express');
const router = express.Router();
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { single } = require('../middleware/mediaUpload');
const mediaController = require('../controllers/media.controller');

// POST /media/upload  (multipart/form-data, field name: `file`)
router.post('/upload', authenticate, authorize(['SELLER', 'ADMIN']), single('file'), mediaController.uploadSingle);

module.exports = router;
