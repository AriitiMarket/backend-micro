// Media controller — standalone single-file image upload.
//
// This is deliberately decoupled from product create/update: the client uploads
// a file here, gets a URL back, and can then reference that URL in any
// `imageUrls` field. The file goes through the existing ImageUploadManager, so
// Cloudinary is used when configured and local disk is the fallback.
const mediaService = require('../services/media.service');
const { ok } = require('../../../shared/utils/response');

function badRequest(message) {
  return (res) => res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message, errors: [] });
}

/**
 * POST /media/upload — upload a single image (field name `file`).
 * Optional body: `folder` (Cloudinary folder, default `eshop`) and
 * `publicId` (explicit Cloudinary public_id).
 */
async function uploadSingle(req, res, next) {
  try {
    if (!req.file) return badRequest('No image file provided (field name "file")')(res);

    const result = await mediaService.uploadSingle(req.file, {
      folder: req.body.folder,
      publicId: req.body.publicId || req.body.public_id,
    });

    return ok(res, { image: result, url: result.url, publicId: result.publicId }, 'Image uploaded successfully');
  } catch (err) {
    return next(err);
  }
}

module.exports = { uploadSingle };
