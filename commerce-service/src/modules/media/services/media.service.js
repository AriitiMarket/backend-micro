// Media upload service — the thin wrapper that gives the existing
// ImageUploadManager (shared/media/imageUploadManager.js) a configured
// singleton and a folder-safe entry point.
//
// The manager already decides Cloudinary vs local disk; this layer only:
//   * wires the commerce Cloudinary env into it,
//   * sanitises the caller-supplied folder (Cloudinary public_id/folder are
//     path segments, so anything outside [A-Za-z0-9_-/] is dropped),
//   * normalises the manager's two result shapes into one `{ url, publicId }`.
const ImageUploadManager = require('../../../shared/media/imageUploadManager');
const env = require('../../../app/config/env');

// Same placeholder guard as app/config/upload.js: the default .env ships
// literal "your_cloud_name" placeholders that are truthy strings, and sending
// them to Cloudinary would fail with "Unknown API key".
const CLOUD_CONFIGURED = Boolean(
  env.cloudinary.apiKey &&
  env.cloudinary.apiSecret &&
  env.cloudinary.cloudName &&
  env.cloudinary.cloudName !== 'your_cloud_name'
);

const uploader = new ImageUploadManager(
  CLOUD_CONFIGURED
    ? {
        cloudinary: {
          cloud_name: env.cloudinary.cloudName,
          api_key: env.cloudinary.apiKey,
          api_secret: env.cloudinary.apiSecret,
        },
      }
    : null
);

/** Keep a Cloudinary folder a safe path: alnum, underscore, dash, slash only. */
function sanitizeFolder(folder) {
  const clean = String(folder || '')
    .trim()
    .replace(/[^A-Za-z0-9_\-\/]/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return clean || 'eshop';
}

/**
 * Upload one buffered image.
 *
 * @param {{buffer: Buffer, originalname: string, mimetype: string}} file multer memory file
 * @param {{folder?: string, publicId?: string}} [options]
 * @returns {Promise<{url: string, publicId: string|null, ...}>}
 */
async function uploadSingle(file, { folder = 'eshop', publicId = null } = {}) {
  if (!file || !file.buffer || !file.buffer.length) {
    const err = new Error('No image file provided');
    err.statusCode = 400;
    throw err;
  }

  const result = await uploader.uploadImage(file, {
    folder: sanitizeFolder(folder),
    public_id: publicId || null,
  });

  return {
    url: result.url,
    publicId: result.publicId || null,
    filename: result.filename || null,
    size: result.size || file.size || null,
    format: result.format || file.mimetype || null,
    width: result.width || null,
    height: result.height || null,
    provider: CLOUD_CONFIGURED ? 'cloudinary' : 'local',
  };
}

module.exports = { uploadSingle, CLOUD_CONFIGURED };
