const multer = require('multer');
const path = require('path');
const fs = require('fs');
const env = require('./env');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const CLOUD_CONFIGURED = Boolean(env.cloudinary.apiKey && env.cloudinary.apiSecret && env.cloudinary.cloudName && env.cloudinary.cloudName !== 'your_cloud_name');

function normalizeFile(file) {
  // Present uploaded files in the Cloudinary shape used elsewhere (file.path = URL,
  // file.filename = public id), so controllers need no change in either mode.
  if (!file) return;
  if (Array.isArray(file)) { file.forEach(normalizeFile); return; }
  // Cloudinary already stores an absolute http(s) URL — leave it alone.
  if (file.path && /^https?:\/\//i.test(String(file.path))) return;
  // Local disk storage sets an absolute filesystem path (e.g. /app/src/uploads/…);
  // always rewrite to the gateway-served /uploads/<filename> form.
  file.path = '/uploads/' + file.filename;
  if (!String(file.filename).startsWith('eshop/')) file.filename = 'eshop/' + file.filename;
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
  storage = new CloudinaryStorage({ cloudinary, params: { folder: 'eshop', allowed_formats: ['jpg', 'jpeg', 'png', 'webp'] } });
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
  // Reject non-image uploads (audit: local storage had no fileFilter, so any
  // file type was written to disk and served back through the gateway).
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) return cb(null, true);
    const err = new Error('Only image files are allowed');
    err.statusCode = 400;
    cb(err);
  },
});
const upload = { single: (f) => wrap(engine.single(f)), array: (f) => wrap(engine.array(f, 10)) };

module.exports = { upload };
