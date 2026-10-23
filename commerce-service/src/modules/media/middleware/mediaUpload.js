// Dedicated single-file upload middleware for the /media endpoint.
//
// Unlike app/config/upload.js (which streams straight to Cloudinary/disk via
// multer's storage engines), this one buffers the file in MEMORY so it can be
// handed to the existing ImageUploadManager, which owns the Cloudinary upload
// + local-fallback decision and the returned { url, publicId, … } shape.
//
// The 5MB cap mirrors app/config/upload.js so both upload surfaces agree.
const multer = require('multer');
const path = require('path');

const engine = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'].includes(ext)) return cb(null, true);
    const err = new Error('Only image files are allowed');
    err.statusCode = 400;
    cb(err);
  },
});

module.exports = { single: (field) => engine.single(field) };
