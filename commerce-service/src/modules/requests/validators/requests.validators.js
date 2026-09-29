const { PRODUCT_REQUEST_STATUSES } = require('../models/Requests');

function failValidation(res, errors) {
  return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
}

function optionalString(body, key, { min = 0, max = 10000 } = {}) {
  if (body[key] === undefined || body[key] === null) return null;
  const value = String(body[key]).trim();
  if (!value) return null;
  if (value.length < min) return `too_short:${min}`;
  if (value.length > max) return `too_long:${max}`;
  return value;
}

function optionalId(body, key) {
  if (body[key] === undefined || body[key] === null || body[key] === '') return null;
  if (typeof body[key] !== 'string') return 'invalid';
  return body[key];
}

/**
 * Structured requirements are deliberately loose: known keys are trimmed
 * strings, unknown keys are dropped, and everything is optional — buyers may
 * describe quality, brand, size, color, packaging plus free notes without the
 * platform pretending to know a fixed product schema.
 */
function normalizeSpecs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const keys = ['quality', 'brand', 'size', 'color', 'packaging', 'notes'];
  const out = {};
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) out[key] = text.slice(0, key === 'notes' ? 1000 : 200);
  }
  return out;
}

/** Unit of measure (Piece, Dozen, kg…) — optional, short, plain text. */
function optionalUnit(body, key = 'unit') {
  if (body[key] === undefined || body[key] === null) return null;
  const value = String(body[key]).trim();
  if (!value) return null;
  if (value.length > 32) return 'too_long:32';
  return value;
}

/**
 * Create a product request.
 *
 * `title` is the field the customer form sends (legacy callers may send
 * `subject` and/or `productName` instead) — at least one must be meaningful.
 * `quantity` must be a positive integer when provided. `shopId` is optional
 * (marketplace-open when absent). `unit` and `specs` carry the structured
 * requirement the seller quotes against.
 */
function validateCreateRequest(req, res, next) {
  const errors = [];
  const body = req.body || {};

  const title = optionalString(body, 'title', { min: 3, max: 300 });
  const subject = optionalString(body, 'subject', { min: 3, max: 300 });
  const productName = optionalString(body, 'productName', { min: 2, max: 200 });
  if (title === 'too_short:3') errors.push('Request title must be at least 3 characters');
  if (title === 'too_long:300') errors.push('Request title must be at most 300 characters');
  if (subject === 'too_short:3') errors.push('Please describe what you need (min 3 chars)');
  if (subject === 'too_long:300') errors.push('Subject must be at most 300 chars');
  if (productName === 'too_short:2') errors.push('Product name must be at least 2 chars');
  if (productName === 'too_long:200') errors.push('Product name must be at most 200 chars');
  if (!title && !subject && !productName) errors.push('Request title is required');

  const details = optionalString(body, 'details', { max: 5000 });
  if (details === 'too_long:5000') errors.push('Details must be at most 5000 chars');

  if (optionalUnit(body) === 'too_long:32') errors.push('Unit must be at most 32 characters');

  if (body.specs !== undefined && body.specs !== null) {
    if (typeof body.specs !== 'object' || Array.isArray(body.specs)) {
      errors.push('specs must be an object');
    } else {
      for (const key of ['quality', 'brand', 'size', 'color', 'packaging', 'notes']) {
        const value = body.specs[key];
        if (value === undefined || value === null) continue;
        const max = key === 'notes' ? 1000 : 200;
        if (String(value).length > max) errors.push(`specs.${key} must be at most ${max} characters`);
      }
    }
  }

  if (body.quantity !== undefined && body.quantity !== null && body.quantity !== '') {
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
      errors.push('Quantity must be a whole number >= 1');
    }
  }

  if (body.targetPrice !== undefined && body.targetPrice !== null && body.targetPrice !== '') {
    const price = Number(body.targetPrice);
    if (!Number.isFinite(price) || price < 0) errors.push('Target price must be a number >= 0');
  }

  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
    const deadline = new Date(body.expiresAt);
    if (Number.isNaN(deadline.getTime())) errors.push('Expiration date is not a valid date');
  }

  if (optionalId(body, 'shopId') === 'invalid') errors.push('shopId must be a string id');
  if (optionalId(body, 'productId') === 'invalid') errors.push('productId must be a string id');
  if (body.attachments !== undefined && body.attachments !== null && !Array.isArray(body.attachments)) {
    errors.push('attachments must be an array');
  } else if (Array.isArray(body.attachments) && body.attachments.length > 10) {
    errors.push('At most 10 attachments are allowed');
  }

  if (errors.length) return failValidation(res, errors);
  next();
}

/** Request conversation message (customer or seller). */
function validateAddMessage(req, res, next) {
  const errors = [];
  const body = req.body || {};
  const text = optionalString(body, 'text', { max: 5000 });
  if (text === 'too_long:5000') errors.push('Message must be at most 5000 chars');

  const label = optionalString(body, 'label', { max: 60 });
  if (label === 'too_long:60') errors.push('Label must be at most 60 chars');

  // Reply target: only the id crosses the wire — the snapshot is rebuilt
  // server-side from the message it actually points at.
  if (optionalId(body, 'replyTo') === 'invalid') errors.push('replyTo must be a message id');

  const images = body.images;
  let imageCount = 0;
  if (images !== undefined && images !== null) {
    if (!Array.isArray(images)) errors.push('images must be an array');
    else {
      imageCount = images.length;
      if (images.length > 10) errors.push('At most 10 images are allowed');
      for (const image of images) {
        if (typeof image === 'string') continue;
        if (!image || typeof image !== 'object' || !image.url) { errors.push('Each image needs a url'); break; }
      }
    }
  }

  if (!text && imageCount === 0) errors.push('Message text or image is required');
  if (errors.length) return failValidation(res, errors);
  next();
}

/** Offer/counter-offer inside the request conversation (either side). */
function validateMakeOffer(req, res, next) {
  const errors = [];
  const body = req.body || {};

  if (body.quantity === undefined || body.quantity === null || body.quantity === '') {
    errors.push('Quantity is required');
  } else {
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) errors.push('Quantity must be a whole number >= 1');
  }

  if (body.unitPrice === undefined || body.unitPrice === null || body.unitPrice === '') {
    errors.push('Unit price is required');
  } else {
    const unitPrice = Number(body.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) errors.push('Unit price must be a number >= 0');
  }

  const productName = optionalString(body, 'productName', { max: 200 });
  if (productName === 'too_long:200') errors.push('Product name must be at most 200 chars');
  const note = optionalString(body, 'note', { max: 1000 });
  if (note === 'too_long:1000') errors.push('Note must be at most 1000 chars');
  if (optionalId(body, 'productId') === 'invalid') errors.push('productId must be a string id');
  if (optionalUnit(body) === 'too_long:32') errors.push('Unit must be at most 32 characters');

  if (body.validUntil !== undefined && body.validUntil !== null && body.validUntil !== '') {
    const validUntil = new Date(body.validUntil);
    if (Number.isNaN(validUntil.getTime())) errors.push('validUntil is not a valid date');
  }

  if (errors.length) return failValidation(res, errors);
  next();
}

/** Explicit agreement confirmation (either side). */
function validateConfirmAgreement(req, res, next) {
  const errors = [];
  const note = optionalString(req.body || {}, 'note', { max: 500 });
  if (note === 'too_long:500') errors.push('Note must be at most 500 characters');
  if (errors.length) return failValidation(res, errors);
  next();
}

/** Abuse report against a request. */
function validateReportRequest(req, res, next) {
  const errors = [];
  const body = req.body || {};
  const reason = optionalString(body, 'reason', { min: 3, max: 500 });
  if (!reason) errors.push('A reason is required to report a request');
  else if (reason === 'too_short:3') errors.push('Reason must be at least 3 characters');
  else if (reason === 'too_long:500') errors.push('Reason must be at most 500 characters');
  const category = optionalString(body, 'category', { max: 40 });
  if (category === 'too_long:40') errors.push('Category must be at most 40 characters');
  const details = optionalString(body, 'details', { max: 2000 });
  if (details === 'too_long:2000') errors.push('Details must be at most 2000 characters');
  if (errors.length) return failValidation(res, errors);
  next();
}

/** Admin: suspend a request (freeze the negotiation). */
function validateSuspendRequest(req, res, next) {
  const errors = [];
  const reason = optionalString(req.body || {}, 'reason', { min: 3, max: 500 });
  if (!reason) errors.push('A reason is required to suspend a request');
  else if (reason === 'too_short:3') errors.push('Reason must be at least 3 characters');
  else if (reason === 'too_long:500') errors.push('Reason must be at most 500 characters');
  if (errors.length) return failValidation(res, errors);
  next();
}

/** Admin: review a report (resolve or dismiss). */
function validateReviewReport(req, res, next) {
  const errors = [];
  const body = req.body || {};
  if (!['RESOLVED', 'DISMISSED'].includes(body.status)) errors.push('status must be RESOLVED or DISMISSED');
  const resolution = optionalString(body, 'resolution', { max: 500 });
  if (resolution === 'too_long:500') errors.push('Resolution must be at most 500 characters');
  if (errors.length) return failValidation(res, errors);
  next();
}

/** Admin: restrict an account from the request surface. */
function validateRestriction(req, res, next) {
  const errors = [];
  const body = req.body || {};
  if (optionalId(body, 'userId') !== body.userId || !body.userId) errors.push('userId is required');
  if (body.scope !== undefined && body.scope !== null && !['BUYER', 'SELLER', 'BOTH'].includes(body.scope)) {
    errors.push('scope must be BUYER, SELLER or BOTH');
  }
  if (body.kind !== undefined && body.kind !== null && !['TEMPORARY', 'PERMANENT'].includes(body.kind)) {
    errors.push('kind must be TEMPORARY or PERMANENT');
  }
  if (body.kind === 'TEMPORARY') {
    if (!body.until) errors.push('A temporary restriction needs an until date');
    else if (Number.isNaN(new Date(body.until).getTime())) errors.push('until is not a valid date');
  }
  const reason = optionalString(body, 'reason', { min: 3, max: 500 });
  if (!reason) errors.push('A reason is required to restrict an account');
  else if (reason === 'too_short:3') errors.push('Reason must be at least 3 characters');
  if (errors.length) return failValidation(res, errors);
  next();
}

/**
 * Admin list query. Supports the admin workspace filters: status/tab, search,
 * buyer/seller, product, date range and price range.
 */
function validateListQuery(req, res, next) {
  const { status, page, limit, tab, minPrice, maxPrice, from, to } = req.query || {};
  const errors = [];
  if (status !== undefined && status !== null && status !== '' && !PRODUCT_REQUEST_STATUSES.includes(status)) {
    errors.push('status must be one of ' + PRODUCT_REQUEST_STATUSES.join(', '));
  }
  const TABS = ['all', 'active', 'negotiating', 'agreed', 'ordered', 'closed', 'reported', 'suspended'];
  if (tab !== undefined && tab !== null && tab !== '' && !TABS.includes(tab)) {
    errors.push('tab must be one of ' + TABS.join(', '));
  }
  if (page !== undefined && page !== null && page !== '' && (!Number.isInteger(Number(page)) || Number(page) < 1)) {
    errors.push('page must be a positive integer');
  }
  if (limit !== undefined && limit !== null && limit !== '' && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)) {
    errors.push('limit must be between 1 and 100');
  }
  for (const key of ['minPrice', 'maxPrice']) {
    const value = req.query?.[key];
    if (value !== undefined && value !== null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      errors.push(`${key} must be a number >= 0`);
    }
  }
  for (const key of ['from', 'to']) {
    const value = req.query?.[key];
    if (value !== undefined && value !== null && value !== '' && Number.isNaN(new Date(value).getTime())) {
      errors.push(`${key} must be a valid date`);
    }
  }
  if (errors.length) return failValidation(res, errors);
  next();
}

module.exports = {
  validateCreateRequest,
  validateAddMessage,
  validateMakeOffer,
  validateConfirmAgreement,
  validateReportRequest,
  validateSuspendRequest,
  validateReviewReport,
  validateRestriction,
  validateListQuery,
  normalizeSpecs,
  optionalUnit,
};
