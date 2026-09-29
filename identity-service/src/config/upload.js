const multer = require('multer');
const path = require('path');
const fs = require('fs');
const env = require('./env');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// Cloudinary is only used when real credentials are present. The placeholder
// values below (from the default .env) are literal, truthy strings that would
// otherwise make CLOUD_CONFIGURED true and cause uploads to fail against a fake
// Cloudinary account ("Unknown API key ..."). We timebox them so local/dev
// uploads fall back to local disk storage instead.
const CLOUDINARY_PLACEHOLDERS = ['your_cloudinary_api_key', 'your_cloudinary_api_secret', 'your_cloud_name'];
const isRealCloudinary = (k, s, n) =>
  Boolean(k && s && n && !CLOUDINARY_PLACEHOLDERS.includes(k) && !CLOUDINARY_PLACEHOLDERS.includes(s) && !CLOUDINARY_PLACEHOLDERS.includes(n));
const CLOUD_CONFIGURED = isRealCloudinary(env.cloudinaryKey, env.cloudinarySecret, env.cloudinaryName);

function normalizeFile(file) {
  if (!file) return;
  if (Array.isArray(file)) { file.forEach(normalizeFile); return; }
  // Cloudinary URLs stay absolute; local disk paths are rewritten to the
  // gateway-served /uploads/<filename> form (absolute FS paths never leak).
  if (file.path && /^https?:\/\//i.test(String(file.path))) return;
  file.path = '/uploads/' + file.filename;
  if (!String(file.filename).startsWith('users/')) file.filename = 'users/' + file.filename;
}

function wrap(middleware) {
  return (req, res, next) => middleware(req, res, (err) => {
    if (!err) {
      if (req.files && req.files.length) normalizeFile(req.files);
      else if (req.file) normalizeFile(req.file);
    }
    next(err);
  });
}

let storage;
if (CLOUD_CONFIGURED) {
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  const cloudinary = require('./cloudinary');
  storage = new CloudinaryStorage({ cloudinary, params: { folder: 'eshop-ident', allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'] } });
} else {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    },
  });
}

const engine = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max per file
});
module.exports = {
  uploadUserFile: wrap(engine.single('file')),
  uploadImageFile: wrap(engine.single('image')),
};
