/**
 * Image-reference policy — the single definition of what a client may put in
 * `product.images` (and similar string galleries).
 *
 * Accepts:
 *   1. Absolute `http(s)` URLs          — external / CDN links
 *   2. Inline `data:image/*` payloads   — tiny inline previews
 *   3. Gateway storage paths            — `/uploads/…`, `/api/uploads/…`,
 *      `uploads/…` (files this platform stored)
 *   4. Real storage keys                — `eshop/<file>`, `users/<file>`,
 *      `folder/key`, `key.png` (Cloudinary public_id style or local key
 *      with or without an image extension)
 *
 * Rejects everything else (`javascript:`, `vbscript:`, `data:text/html`,
 * whitespace-heavy junk, protocol-relative `//evil`, etc.): these strings end
 * up in `<img src>` in the storefront, so an unsafe scheme is an XSS vector.
 *
 * Storage keys are normalized to a gateway-served path when they clearly map
 * to a local upload (`eshop/x.png`, `users/x.png`, bare `x.png` →
 * `/uploads/x.png`). Keys that look like remote public_ids (folder/key with
 * no local prefix) are kept verbatim so Cloudinary-style ids survive.
 *
 * @param {string} raw candidate reference
 * @returns {string|null} the reference when acceptable, otherwise null
 */
function sanitizeImageReference(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  // Inline image payloads only — never data:text/html or other MIME types.
  if (/^data:image\//i.test(value)) return value;

  // Absolute http(s) URLs. Explicitly refuse scheme-relative "//host/…" which
  // browsers treat as the current page's protocol (and which `new URL` would
  // reject anyway without a base).
  if (value.startsWith('//')) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
    return null; // javascript:, file:, etc.
  } catch {
    /* not an absolute URL — fall through to storage-key rules */
  }

  // Gateway / local storage paths (root-relative).
  //   /uploads/x.png, /api/uploads/x.png, uploads/x.png
  const stripped = value.replace(/^\/+/, '');
  if (/^api\/uploads\//i.test(stripped)) {
    return '/' + stripped; // /api/uploads/… is also served by the gateway
  }
  if (/^uploads\//i.test(stripped)) {
    return '/' + stripped; // /uploads/…
  }
  if (value.startsWith('/') && /\/uploads\//.test(value)) {
    return value.slice(value.indexOf('/uploads/'));
  }

  // Real storage keys:
  //   eshop/<file>, users/<file>, harar/fresh_market, key.png, a/b/c.webp
  // Must be path-segment safe: no spaces, no "..", no ":" (blocks schemes),
  // no leading dot.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value)) {
    return null;
  }
  if (value.includes('..')) return null;

  // Local disk keys are stored under eshop/ or users/ (see app/config/upload.js)
  // but the file itself lives at /uploads/<basename>. Normalize so one string
  // is enough for both public_id and display URL.
  const localPrefix = /^(eshop|users)\//i.exec(value);
  if (localPrefix) {
    const base = value.slice(localPrefix[0].length);
    if (base && !base.includes('/')) return '/uploads/' + base;
    return value;
  }

  // Bare filename with an image extension → assume local upload.
  if (!value.includes('/') && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value)) {
    return '/uploads/' + value;
  }

  // Folder-style key (e.g. Cloudinary public_id `harar/fresh_market`) with no
  // image extension — keep verbatim for round-trip as a storage key.
  if (value.includes('/')) return value;

  // Single-segment key without an image extension is too ambiguous — drop it.
  return null;
}

/**
 * Build the `{ public_id, url }` pair used by shop / user / event avatars from
 * either an external URL or a real storage key.
 *
 * @param {string} raw URL or storage key
 * @returns {{public_id: string, url: string}|null}
 */
function avatarRefFromInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const safe = sanitizeImageReference(value);
  if (!safe) return null;
  if (/^(https?:|data:)/i.test(safe)) {
    return { public_id: safe, url: safe };
  }
  // Prefer the original storage-key form as public_id so it matches multer
  // (`filename = "eshop/<file>"`, `path = "/uploads/<file>"`). Only strip a
  // leading `uploads/` when the caller passed a pure gateway path.
  const original = value.replace(/^\/+/, '').replace(/^api\//, '');
  const publicId = /^uploads\//i.test(original)
    ? original.replace(/^uploads\//i, '')
    : original;
  return { public_id: publicId, url: safe };
}

module.exports = { sanitizeImageReference, avatarRefFromInput };
