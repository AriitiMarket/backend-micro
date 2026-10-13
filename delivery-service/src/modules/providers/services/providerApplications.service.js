// Provider application domain logic.
//
// DESIGN: a provider application IS a Provider document in `pending` status.
// There is no second "application" collection to keep in sync — the admin review
// queue is simply the provider roster filtered by status, and every field the
// applicant submits maps onto an existing Provider field (`vehicleType`,
// `plateNumber`, ...). Application-specific answers that have no first-class
// column (availability, experience, insurance, ID document reference) live under
// `metadata.application`, which the Provider schema already provides. Approval
// therefore needs no "copy application -> provider" step; it flips the status
// and provisions the account role.
const providersRepo = require('../repositories/providers.repository');
const auditClient = require('../../../shared/utils/audit-client');
const identityClient = require('../../../shared/utils/identity-client');

// Mirrors the Provider schema enums — keep in sync with models/Provider.js.
const PROVIDER_TYPES = ['individual_rider', 'delivery_business', 'logistics_partner'];
const { VEHICLE_TYPES } = require('../../../shared/constants');

// Statuses an applicant may (re)submit into: a fresh or still-reviewed
// application (`pending`) can be amended, and a `rejected` one can be
// re-applied (it returns to `pending` for review). Anything else means they are
// a live provider or suspended, and must go through an admin.
const APPLICANT_EDITABLE_STATUSES = ['pending', 'rejected'];
// Only an application still awaiting review may be withdrawn outright.
const WITHDRAWABLE_STATUSES = ['pending'];

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }
function notFound(message) { return Object.assign(new Error(message), { status: 404 }); }

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/** Required application fields -> validated Provider fields. */
function buildApplicationPayload(body = {}) {
  const name = cleanText(body.name, 120);
  const phone = cleanText(body.phone, 40);
  if (!name) throw badRequest('Full name is required');
  if (!phone) throw badRequest('Phone number is required');

  const providerType = cleanText(body.providerType, 40) || 'individual_rider';
  if (!PROVIDER_TYPES.includes(providerType)) {
    throw badRequest(`providerType must be one of: ${PROVIDER_TYPES.join(', ')}`);
  }

  const vehicleType = cleanText(body.vehicleType, 40) || 'bicycle';
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    throw badRequest(`vehicleType must be one of: ${VEHICLE_TYPES.join(', ')}`);
  }

  const incoming = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const application = {
    availability: cleanText(incoming.availability, 500),
    experience: cleanText(incoming.experience, 1000),
    vehicleModel: cleanText(incoming.vehicleModel, 120),
    hasInsurance: Boolean(incoming.hasInsurance),
    // Only a reference is stored. Binary document storage belongs to the
    // uploads service; no public multipart endpoint exists for this flow yet,
    // so the reviewer sees the filename/URL the applicant supplied.
    idDocumentName: cleanText(incoming.idDocumentName, 200),
    idDocumentUrl: cleanText(incoming.idDocumentUrl, 500),
    submittedAt: new Date(),
  };

  // Requested operating location (City / Zone / Port) — OPTIONAL: a registration
  // form that collects it submits it here, the application carries it, and the
  // reviewer approves the location WITH the application instead of asking the
  // admin to re-assign a zone after every approval. Stored on the same Provider
  // document (an application IS a pending provider), so approval needs no copy
  // step. Values are only lightly validated here; the admin reviews them.
  const zoneIds = Array.isArray(body.zoneIds)
    ? [...new Set(body.zoneIds.map((z) => cleanText(z, 64)).filter(Boolean))]
    : [];
  const portId = cleanText(body.portId, 64) || null;
  const cityId = cleanText(body.cityId, 64) || null;

  return {
    fields: {
      name,
      phone,
      email: cleanText(body.email, 160) || null,
      providerType,
      vehicleType,
      plateNumber: cleanText(body.plateNumber, 40),
      serviceId: body.serviceId || null,
      // The location is written in FULL on every (re)submission — an empty
      // array / null means "not requested this time" and CLEARS whatever the
      // previous application asked for. Merging would let a new application be
      // approved against a stale City/Zone/Port it never requested (§4).
      zoneIds,
      zoneId: zoneIds.length > 0 ? zoneIds[0] : null,
      portId,
      cityId,
      metadata: { application },
    },
    application,
  };
}


/**
 * Create or amend the caller's own provider application.
 * Re-submitting while `pending` amends the existing record rather than
 * duplicating it (the Provider id is the application id the UI tracks), so the
 * caller learns which happened from `created` — a fresh submission is a 201, an
 * amendment is a 200.
 * 
 * Now integrated with Identity Service membership system:
 * - If user already has PENDING PROVIDER membership from registration, this creates the detailed application
 * - If no membership exists, this creates the application and will trigger membership creation on approval
 * @returns {Promise<{provider: object, created: boolean}>}
 */
async function applyForProvider(identityUserId, body) {
  if (!identityUserId) throw badRequest('Authenticated user is required');
  const { fields } = buildApplicationPayload(body);
  const existing = await providersRepo.findByIdentityUserId(identityUserId);

  if (existing) {
    if (!APPLICANT_EDITABLE_STATUSES.includes(existing.status)) {
      throw conflict(
        existing.status === 'suspended'
          ? 'Your provider account is suspended. Please contact support.'
          : 'You are already a registered delivery provider'
      );
    }
    // Re-applying after a rejection clears the stored decision and puts the
    // record back in the review queue; the new submission replaces the old one.
    const application = fields.metadata.application;
    const provider = await providersRepo.updateFields(existing._id, {
      ...fields,
      status: 'pending',
      metadata: {
        ...(existing.metadata || {}),
        application,
      },
    });
    await syncMembershipAfterSubmission(identityUserId, existing.status);
    await notifyOnboardingComplete(identityUserId);
    return { provider, created: false };
  }

  // Check if user already has a PENDING PROVIDER membership from registration
  // If so, link this application to that membership
  let identityMembershipSynced = false;
  try {
    // Note: Delivery service would need to implement similar identity client call
    // For now, we'll add metadata that can be checked later
    fields.metadata = fields.metadata || {};
    fields.metadata.registrationSource = 'APPLICATION';
  } catch (e) {
    // Non-fatal - continue with application creation
    console.warn('[applyForProvider] membership check warning:', e.message);
  }

  const provider = await providersRepo.create({ 
    ...fields, 
    identityUserId, 
    status: 'pending',
    metadata: {
      ...(fields.metadata || {}),
      identityMembershipSynced,
    }
  });
  await notifyOnboardingComplete(identityUserId);
  return { provider, created: true };
}

/**
 * Put the account-side membership back in step after a re-submission.
 *
 * Only the rejected -> pending case needs a write: a rejection moves the
 * Identity membership to REJECTED, so without this the role gate keeps showing
 * "not approved" while the new application already sits in the review queue.
 * First-time applicants have no membership row yet — approval grants it — and
 * an amendment of a still-pending application is already PENDING.
 */
async function syncMembershipAfterSubmission(identityUserId, previousStatus) {
  if (previousStatus !== 'rejected') return;
  try {
    const result = await identityClient.setProviderMembershipStatus(identityUserId, 'PENDING');
    if (!result.ok && result.status !== 404) {
      console.warn(`[applyForProvider] membership reset to PENDING failed: ${result.reason || result.status}`);
    }
  } catch (err) {
    console.warn(`[applyForProvider] membership reset warning: ${err.message}`);
  }
}

/**
 * Tell Identity the applicant finished the onboarding wizard (called on every
 * submission). This keeps a PENDING membership out of the abandoned-application
 * cleanup, which only reclaims applications that were never submitted.
 * Non-fatal: the Provider document is the source of truth for the review queue.
 */
async function notifyOnboardingComplete(identityUserId) {
  if (!identityUserId) return;
  try {
    const result = await identityClient.markOnboardingComplete(identityUserId);
    if (!result.ok && result.status !== 404) {
      console.warn(`[applyForProvider] onboarding completion sync failed: ${result.reason || result.status}`);
    }
  } catch (err) {
    console.warn(`[applyForProvider] onboarding completion sync warning: ${err.message}`);
  }
}

/** The caller's own application/provider record, or null when they never applied. */
async function getMyApplication(identityUserId) {
  if (!identityUserId) throw badRequest('Authenticated user is required');
  return providersRepo.findByIdentityUserId(identityUserId);
}

/** Delete an application that is still awaiting review (never a decided one). */
async function withdrawMyApplication(identityUserId) {
  const existing = await getMyApplication(identityUserId);
  if (!existing) throw notFound('No provider application found');
  if (!WITHDRAWABLE_STATUSES.includes(existing.status)) {
    throw conflict(`A ${existing.status} provider account cannot be withdrawn`);
  }
  await providersRepo.remove(existing._id);
  return { id: String(existing._id) };
}

/** Admin review queue — applications awaiting a decision. */
async function listPendingApplications(filter = {}, options = {}) {
  return providersRepo.findAll({ ...filter, status: 'pending' }, options);
}

function auditApplicationSubmitted(provider, actor) {
  if (!auditClient || typeof auditClient.sendAudit !== 'function') return;
  auditClient.sendAudit({
    action: 'PROVIDER_APPLICATION_SUBMITTED',
    targetEntity: 'provider',
    targetId: provider._id,
    adminId: actor?.id,
    adminName: actor?.name,
    metadata: { identityUserId: provider.identityUserId },
  }).catch(() => null);
}

module.exports = {
  applyForProvider,
  getMyApplication,
  withdrawMyApplication,
  listPendingApplications,
  auditApplicationSubmitted,
  buildApplicationPayload,
  PROVIDER_TYPES,
  VEHICLE_TYPES,
};
