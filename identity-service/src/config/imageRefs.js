/**
 * Avatar / image-reference policy for Identity avatars.
 *
 * Same dual contract as Commerce `imageRefs.js`:
 *   1. Absolute `http(s)` URLs          — external / CDN links
 *   2. Inline `data:image/*` payloads
 *   3. Gateway storage paths            — `/uploads/…`, `/api/uploads/…`
 *   4. Real storage keys                — `users/<file>`, `folder/key`, `key.png`
 *
 * Returns `{ publicId, url }` or null when the input is not acceptable.
 * `javascript:` / other schemes never enter `avatar_public_id` / `avatar_url`.
 */
function sanitizeImageReference(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  if (/^data:image\//i.test(value)) return value;

  if (value.startsWith('//')) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
    return null;
  } catch {
    /* not absolute — storage-key rules below */
  }

  const stripped = value.replace(/^\/+/, '');
  if (/^api\/uploads\//i.test(stripped)) return '/' + stripped;
  if (/^uploads\//i.test(stripped)) return '/' + stripped;
  if (value.startsWith('/') && /\/uploads\//.test(value)) {
    return value.slice(value.indexOf('/uploads/'));
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value)) {
    return null;
  }
  if (value.includes('..')) return null;

  const localPrefix = /^users\//i.exec(value);
  if (localPrefix) {
    const base = value.slice(localPrefix[0].length);
    if (base && !base.includes('/')) return '/uploads/' + base;
    return value;
  }

  if (!value.includes('/') && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value)) {
    return '/uploads/' + value;
  }

  if (value.includes('/')) return value;
  return null;
}

/** Build `{ publicId, url }` from an external URL or a real storage key. */
function avatarRefFromInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const safe = sanitizeImageReference(value);
  if (!safe) return null;
  if (/^(https?:|data:)/i.test(safe)) {
    return { publicId: safe, url: safe };
  }
  // Prefer the original storage-key form as public_id so it matches multer
  // (`filename = "users/<file>"`, `path = "/uploads/<file>"`). Only strip a
  // leading `uploads/` when the caller passed a pure gateway path.
  const original = value.replace(/^\/+/, '').replace(/^api\//, '');
  const publicId = /^uploads\//i.test(original)
    ? original.replace(/^uploads\//i, '')
    : original;
  return { publicId, url: safe };
}

/** File upload wins; otherwise accept URL or storage key from the body. */
function resolveAvatar(req) {
  if (req.file) {
    return { publicId: req.file.filename, url: req.file.path };
  }
  const body = req.body || {};
  return avatarRefFromInput(body.avatarUrl || body.avatar || body.avatar_url);
}

module.exports = { sanitizeImageReference, avatarRefFromInput, resolveAvatar };
