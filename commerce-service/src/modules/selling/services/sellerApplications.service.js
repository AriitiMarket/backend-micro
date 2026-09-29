const sellerAppRepository = require('../repositories/sellerApplications.repository');
const shopRepository = require('../repositories/shops.repository');
const shopService = require('./shops.service');
const { identityClient } = require('../../../app/clients/identity.client');
const auditService = require('../../../shared/utils/audit-client');
const { validateCategory } = require('../../../shared/utils/categoryValidator');

class ApiError extends Error {
  constructor(message, statusCode, errors = []) { super(message); this.statusCode = statusCode; this.errors = errors; }
}

const STATUSES = ['DRAFT', 'PENDING_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'];
const EDITABLE_STATUSES = ['DRAFT', 'REJECTED', 'MORE_INFORMATION_REQUIRED'];

/** Resolve Identity user → display fields (name/email). Never fails the page. */
async function resolveOwnerDisplay(ownerId) {
  if (!ownerId) return null;
  try {
    const res = await identityClient.findUser(String(ownerId));
    if (!res || res.status >= 400 || !res.body || !res.body.user) return null;
    const u = res.body.user;
    return { id: u.id || u._id || String(ownerId), name: u.name || null, email: u.email || null };
  } catch (e) {
    console.error('[resolveOwnerDisplay] identity lookup warning:', e.message);
    return null;
  }
}

function timelineEntry(status, changedBy, reason) {
  return { status, changedBy, changedAt: new Date(), ...(reason ? { reason } : {}) };
}

function validateSubmission(payload) {
  const errors = [];
  const business = payload.businessInformation || {};
  const location = payload.location || {};
  const shop = payload.shopInformation || {};
  if (!payload.sellerType) errors.push('sellerType is required');
  if (!business.businessName || String(business.businessName).trim().length < 2) errors.push('businessInformation.businessName is required');
  if (!business.businessCategory || !String(business.businessCategory).trim()) errors.push('businessInformation.businessCategory is required');
  if (!location.city && !location.cityName) errors.push('location.city is required');
  if (!shop.shopName || String(shop.shopName).trim().length < 2) errors.push('shopInformation.shopName is required');
  if (errors.length) throw new ApiError('Seller application validation failed', 422, errors);
}

/**
 * FEATURE 6: Calculate seller verification score (0-100)
 * Based on: document verification, email/phone verification, address match, application age
 */
function calculateVerificationScore(app) {
  let score = 0;

  // Document verification (30 points)
  if (app.verificationStatus?.documentsVerified) score += 30;
  if (app.verificationStatus?.emailVerified) score += 15;
  if (app.verificationStatus?.phoneVerified) score += 15;
  if (app.verificationStatus?.addressVerified) score += 20;

  // Time-based: Rush detection (negative points for very recent applications)
  if (app.submittedAt) {
    const hoursOld = (Date.now() - app.submittedAt.getTime()) / (1000 * 60 * 60);
    if (hoursOld < 1) score -= 20; // Rushed
    else if (hoursOld < 24) score -= 10;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

/**
 * FEATURE 6: Detect risk flags from application data
 */
function detectRiskFlags(app) {
  const flags = [];

  if (app.verificationStatus?.documentsVerified === false) {
    flags.push('DOCUMENT_MISMATCH');
  }
  if (app.verificationStatus?.addressVerified === false) {
    flags.push('ADDRESS_MISMATCH');
  }

  // Domain reputation risk (e.g., free email domains for business)
  if (app.businessInformation?.email) {
    const email = app.businessInformation.email.toLowerCase();
    if (email.includes('@gmail.com') || email.includes('@yahoo.com') || email.includes('@hotmail.com')) {
      flags.push('FREE_EMAIL_DOMAIN');
    }
  }

  // Missing critical information
  if (!app.businessInformation?.businessName) flags.push('MISSING_BUSINESS_NAME');
  if (!app.location?.city) flags.push('MISSING_LOCATION');
  if (!app.shopInformation?.shopName) flags.push('MISSING_SHOP_NAME');

  return flags;
}

class SellerApplicationService {
  /**
   * Create or upsert (DRAFT) an application for a buyer/user. Does NOT grant
   * seller access — it simply records the onboarding application.
   * 
   * Now integrated with Identity Service membership system:
   * - If user already has PENDING SELLER membership from registration, this creates the detailed application
   * - If no membership exists, this creates the application and will trigger membership creation on approval
   */
  async saveApplication(ownerId, payload) {
    if (!ownerId) throw new ApiError('Authentication required', 401);
    if (payload.submit) {
      validateSubmission(payload);
      const business = payload.businessInformation || {};
      const shop = payload.shopInformation || {};
      await validateCategory(business.businessCategory, 'business');
      // `shopInformation.category` carries the SAME value as
      // `businessInformation.businessCategory` (the seller form sends one
      // select for both). Shop browsing uses the 'business' category type —
      // validating it as 'shop' silently passed only because no 'shop'-type
      // rows exist, so a typo'd category would have reached the Shop doc.
      await validateCategory(shop.category, 'business');
    }

    const sanitized = {
      ...(payload.sellerType !== undefined ? { sellerType: payload.sellerType } : {}),
      ...(payload.businessInformation !== undefined ? { businessInformation: payload.businessInformation } : {}),
      ...(payload.location !== undefined ? { location: payload.location } : {}),
      ...(payload.shopInformation !== undefined ? { shopInformation: payload.shopInformation } : {}),
    };

    const existing = await sellerAppRepository.findByOwner(ownerId);
    if (existing) {
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new ApiError(`Application cannot be modified while ${existing.status}`, 409);
      }
      if (payload.submit) {
        sanitized.status = 'PENDING_REVIEW';
        sanitized.submittedAt = new Date();
        sanitized.review = {
          ...(existing.review || {}),
          rejectionReason: null,
          informationRequestReason: null,
        };
        sanitized.statusTimeline = [
          ...(existing.statusTimeline || []),
          timelineEntry('PENDING_REVIEW', ownerId),
        ];
      }
      // Update BY ID, never by `ownerId`: `findByOwner` matches `ownerId OR
      // userId`, so a legacy document keyed only by `userId` would be found but
      // not matched by an `{ ownerId }` update — the write silently returned
      // null and the next save created a SECOND, stale application (the
      // "approved business with a draft still hanging around" bug).
      return sellerAppRepository.updateById(existing._id, sanitized);
    }

    if (payload.submit) {
      sanitized.status = 'PENDING_REVIEW';
      sanitized.submittedAt = new Date();
    }
    const status = sanitized.status || 'DRAFT';
    
    // Check if user already has a PENDING SELLER membership from registration
    // If so, link this application to that membership
    try {
      const membershipCheck = await identityClient.checkMembershipStatus(ownerId, 'SELLER');
      if (membershipCheck?.body?.status === 'PENDING') {
        sanitized.identityMembershipSynced = true;
        sanitized.membershipSource = 'REGISTRATION';
      }
    } catch (e) {
      // Non-fatal - continue with application creation
      console.warn('[saveApplication] membership check warning:', e.message);
    }
    
    return sellerAppRepository.create({
      ownerId,
      userId: ownerId,
      ...sanitized,
      status,
      statusTimeline: [timelineEntry(status, ownerId)],
    });
  }

  async getMyApplication(ownerId) {
    if (!ownerId) throw new ApiError('Authentication required', 401);
    const app = await sellerAppRepository.findByOwner(ownerId);
    if (app) {
      // FEATURE 6: Enrich with verification score and risk flags
      app.verificationScore = calculateVerificationScore(app);
      app.riskFlags = detectRiskFlags(app);
    }
    return app;
  }

  /**
   * Owner: discard an abandoned DRAFT.
   *
   * A seller who never submitted (or whose account already operates shops
   * created another way) is left with a DRAFT that lingers forever in the
   * admin Businesses list with no actions available. Only DRAFT may be
   * discarded — anything that was ever reviewed keeps its timeline for audit.
   */
  async discardDraft(ownerId) {
    if (!ownerId) throw new ApiError('Authentication required', 401);
    const app = await sellerAppRepository.findByOwner(ownerId);
    if (!app) throw new ApiError('No application found', 404);
    if (app.status !== 'DRAFT') {
      throw new ApiError(`Only a draft can be discarded (current status: ${app.status})`, 409);
    }
    await sellerAppRepository.deleteById(app._id);
    return { id: String(app._id) };
  }

  /** Admin: list applications by status. */
  async listApplications(status, page = 1, size = 10, search = '') {
    const filter = status && STATUSES.includes(status) ? { status } : {};
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedSize = Math.min(100, Math.max(1, Number(size) || 10));
    if (search && String(search).trim()) {
      const expression = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { ownerId: expression },
        { userId: expression },
        { 'businessInformation.businessName': expression },
        { 'shopInformation.shopName': expression },
      ];
    }
    const [apps, total] = await Promise.all([
      sellerAppRepository.find(filter, { skip: (normalizedPage - 1) * normalizedSize, limit: normalizedSize }),
      sellerAppRepository.count(filter),
    ]);

    // FEATURE 6: Enrich each app with verification score, risk flags, and a
    // readable owner (Identity hydration — the admin list must never show a
    // bare ownerId as the owner name).
    const hydrated = await Promise.all(
      apps.map(async (app) => {
        const owner = await resolveOwnerDisplay(app.ownerId);
        return {
          ...app.toObject?.() || app,
          verificationScore: calculateVerificationScore(app),
          riskFlags: detectRiskFlags(app),
          ownerName: owner?.name || null,
          ownerEmail: owner?.email || null,
          owner,
        };
      })
    );

    return {
      applications: hydrated,
      total,
      page: normalizedPage,
      size: normalizedSize,
      limit: normalizedSize,
      totalPages: Math.ceil(total / normalizedSize),
    };
  }

  /** Admin: view one application (owner + linked shop hydrated). */
  async getApplication(id) {
    const app = await sellerAppRepository.findById(id);
    if (!app) throw new ApiError('Application not found', 404);

    const plain = app.toObject?.() || app;
    const [owner, linkedShop, reviewUser] = await Promise.all([
      resolveOwnerDisplay(app.ownerId),
      app.shopId
        ? shopRepository.findById(String(app.shopId)).catch(() => null)
        : Promise.resolve(null),
      app.review?.reviewedBy
        ? resolveOwnerDisplay(app.review.reviewedBy)
        : Promise.resolve(null),
    ]);

    return {
      ...plain,
      verificationScore: calculateVerificationScore(app),
      riskFlags: detectRiskFlags(app),
      ownerName: owner?.name || null,
      ownerEmail: owner?.email || null,
      owner,
      // `application.shop` never existed; hydrate the created shop so the
      // Linked Shop card has real name/status instead of `—`.
      shop: linkedShop
        ? {
            id: linkedShop._id,
            name: linkedShop.name,
            status: linkedShop.status,
            locationSnapshot: linkedShop.locationSnapshot || null,
            productCount: linkedShop.productCount,
          }
        : null,
      review: plain.review
        ? {
            ...plain.review,
            reviewedByName: reviewUser?.name || null,
            reviewedByEmail: reviewUser?.email || null,
          }
        : plain.review,
    };
  }

  async assertOwner(ownerId, app) {
    if (!app) throw new ApiError('Application not found', 404);
    if (String(app.ownerId) !== String(ownerId)) {
      throw new ApiError('Forbidden: you can only manage your own application', 403);
    }
  }

  /**
   * Admin: approve a seller application.
   *  - Sets status = APPROVED on the application.
   *  - Creates a Shop (business record) in Commerce from application.shopInformation,
   *    linked to ownerId, locationId, sectorId, and applicationId.
   *  - Requests Identity Service (via the gateway/internal channel) to grant the
   *    SELLER role — this is the only place a seller role is activated.
   * Microservice boundary is respected: Commerce never writes Identity Postgres.
   */
  async approve(id, reviewedBy, locationId, sectorId) {
    const app = await sellerAppRepository.findById(id);
    if (!app) throw new ApiError('Application not found', 404);

    if (app.status === 'APPROVED' && app.shopId) {
      return { application: app, shopWasCreated: false };
    }
    if (app.status !== 'PENDING_REVIEW') {
      throw new ApiError(`Cannot approve application while ${app.status}`, 409);
    }

    // 1) Build the shop from the application's shop information.
    const shopInfo = app.shopInformation || {};
    const location = app.location || {};
    const business = app.businessInformation || {};

    if (!shopInfo.shopName) throw new ApiError('Cannot approve: shop name is missing', 400);

    const avatar = shopInfo.logo && shopInfo.logo.url ? shopInfo.logo : { public_id: 'default', url: '' };
    if (!avatar.url) {
      // /uploads fallback avatar served by the gateway.
      avatar.url = '/app/uploads/shop-default.svg';
    }

    const shop = await shopRepository.create({
      name: shopInfo.shopName,
      email: shopInfo.publicEmail || business.email || (app.ownerId + '@aritii.local'),
      ownerId: app.ownerId,
      description: shopInfo.description || business.description || '',
      // Shop category (type 'business') — what the public /shops sidebar
      // filters on. Prefer the shop-level pick, fall back to the business one.
      category: String(shopInfo.category || business.businessCategory || '').trim(),
      address: location.address || location.city || '',
      // Phone/zip stay strings (validators allow "+251-911…" / leading zeros).
      // zipCode is not a region id — when the application has no zip we leave it
      // empty rather than stuffing Number(region) into the field.
      phoneNumber: shopInfo.publicPhone != null && String(shopInfo.publicPhone).trim() !== ''
        ? String(shopInfo.publicPhone).trim()
        : '',
      avatar,
      zipCode: location.zipCode != null && String(location.zipCode).trim() !== ''
        ? String(location.zipCode).trim()
        : '',
      // NEW: Link to location, sector, and application
      locationId: locationId || null,
      sectorId: sectorId || null,
      applicationId: String(app._id),
      status: 'APPROVED',
      approvalMetadata: {
        approvedBy: reviewedBy,
        approvedAt: new Date(),
      },
    });

    // Link the shop to the identity user (best-effort).
    try { await identityClient.linkShopId(app.ownerId, String(shop._id)); } catch (e) { /* non-fatal */ }

    // 2) Mark application approved.
    const application = await sellerAppRepository.updateById(id, {
      status: 'APPROVED',
      shopId: String(shop._id),
      approvedAt: new Date(),
      review: { reviewedBy, reviewedAt: new Date(), rejectionReason: null },
      // FEATURE 7: Initialize timeline/history tracking
      statusTimeline: [
        ...(app.statusTimeline || []),
        {
          status: 'APPROVED',
          changedBy: reviewedBy,
          changedAt: new Date(),
          reason: 'Application approved',
        },
      ],
    });

    // 3) Activate the SELLER role in Identity Service (via gateway/internal).
    const roleRes = await identityClient.grantSellerRole(app.ownerId);
    if (roleRes.status >= 400) {
      // Do not throw here — the shop/application are already approved; log it.
      console.error(`[approve] role grant warning for ${app.ownerId}: ${roleRes.status}`);
    }

    // 4) Set seller status to APPROVED in Identity Service so frontend knows user is approved.
    try {
      await identityClient.setSellerStatus(app.ownerId, 'APPROVED');
    } catch (e) {
      console.error(`[approve] sellerStatus sync warning for ${app.ownerId}:`, e.message);
      // Non-fatal — the seller role is already granted
    }

    // 5) Log the approval action to audit
    try {
      await auditService.logAction({
        action: 'SELLER_APPLICATION_APPROVED',
        adminId: reviewedBy,
        targetUserId: app.ownerId,
        details: {
          applicationId: id,
          businessName: app.businessInformation?.businessName,
          shopId: String(shop._id),
          verificationScore: calculateVerificationScore(app),
        },
        level: 'CRITICAL',
      });
    } catch (e) {
      console.error('[approve] audit logging warning:', e.message);
    }

    return { application, shop, roleResult: roleRes };
  }

  /** Admin: reject an application. */
  async reject(id, reviewedBy, reason) {
    const app = await sellerAppRepository.findById(id);
    if (!app) throw new ApiError('Application not found', 404);
    if (app.status !== 'PENDING_REVIEW') {
      throw new ApiError(`Cannot reject application while ${app.status}`, 409);
    }
    
    const result = await sellerAppRepository.updateById(id, {
      status: 'REJECTED',
      rejectedAt: new Date(),
      review: {
        ...(app.review || {}),
        reviewedBy,
        reviewedAt: new Date(),
        rejectionReason: reason || 'Not approved at this time',
        informationRequestReason: null,
      },
      // FEATURE 7: Track rejection in timeline
      statusTimeline: [
        ...(app.statusTimeline || []),
        {
          status: 'REJECTED',
          changedBy: reviewedBy,
          changedAt: new Date(),
          reason: reason || 'Application rejected',
        },
      ],
    });

    // Log the rejection action to audit
    try {
      await auditService.logAction({
        action: 'SELLER_APPLICATION_REJECTED',
        adminId: reviewedBy,
        targetUserId: app.ownerId,
        details: {
          applicationId: id,
          businessName: app.businessInformation?.businessName,
          reason,
          riskFlags: detectRiskFlags(app),
        },
        level: 'WARNING',
        reason,
      });
    } catch (e) {
      console.error('[reject] audit logging warning:', e.message);
    }

    return result;
  }

  /** Admin: ask the applicant for additional information. */
  async requestInformation(id, reviewedBy, reason) {
    if (!reason || !String(reason).trim()) {
      throw new ApiError('A reason is required when requesting information', 400);
    }
    const app = await sellerAppRepository.findById(id);
    if (!app) throw new ApiError('Application not found', 404);
    if (app.status !== 'PENDING_REVIEW') {
      throw new ApiError(`Cannot request information while ${app.status}`, 409);
    }

    return sellerAppRepository.updateById(id, {
      status: 'MORE_INFORMATION_REQUIRED',
      review: {
        ...(app.review || {}),
        reviewedBy,
        reviewedAt: new Date(),
        informationRequestReason: String(reason).trim(),
        rejectionReason: null,
      },
      statusTimeline: [
        ...(app.statusTimeline || []),
        timelineEntry('MORE_INFORMATION_REQUIRED', reviewedBy, String(reason).trim()),
      ],
    });
  }

  /** Admin: suspend (or re-activate) a seller/shop. */
  async setSuspended(id, suspended, reviewedBy) {
    const app = await sellerAppRepository.findById(id);
    if (!app) throw new ApiError('Application not found', 404);

    // 1) Cascade to this business's shops FIRST, so a failure leaves everything
    //    unchanged: a suspended business must never keep an APPROVED shop (and
    //    therefore its products) publicly visible. Reactivation only restores
    //    the shops this call suspended — a rejected (INACTIVE) shop stays
    //    rejected.
    const shopStatus = suspended ? 'SUSPENDED' : 'APPROVED';
    const shopFilter = suspended
      ? { ownerId: app.ownerId, status: { $ne: 'SUSPENDED' } }
      : { ownerId: app.ownerId, status: 'SUSPENDED' };
    const shops = await shopRepository.find({ filter: shopFilter });
    for (const shop of shops) {
      await shopService.updateShopStatus(String(shop._id), shopStatus, reviewedBy, {
        reason: suspended ? 'Business suspended' : null,
      });
    }

    // PHASE 3: Sync suspension status to Identity Service
    if (suspended) {
      try {
        await identityClient.suspendSeller(app.ownerId);
      } catch (err) {
        console.error(`[suspend] Failed to sync suspension to Identity for ${app.ownerId}:`, err.message);
        // Don't fail the suspension if Identity sync fails (non-blocking)
      }
    } else {
      try {
        await identityClient.reactivateSeller(app.ownerId);
      } catch (err) {
        console.error(`[reactivate] Failed to sync reactivation to Identity for ${app.ownerId}:`, err.message);
        // Don't fail the reactivation if Identity sync fails (non-blocking)
      }
    }
    
    const result = await sellerAppRepository.updateById(id, {
      status: suspended ? 'SUSPENDED' : 'APPROVED',
      review: { reviewedBy, reviewedAt: new Date(), rejectionReason: null },
      // FEATURE 7: Track suspension in timeline
      statusTimeline: [
        ...(app.statusTimeline || []),
        {
          status: suspended ? 'SUSPENDED' : 'APPROVED',
          changedBy: reviewedBy,
          changedAt: new Date(),
          reason: suspended ? 'Seller suspended' : 'Seller reactivated',
        },
      ],
    });

    // Log the suspension/reactivation action to audit
    try {
      await auditService.logAction({
        action: suspended ? 'SELLER_BUSINESS_SUSPENDED' : 'SELLER_BUSINESS_REACTIVATED',
        adminId: reviewedBy,
        targetUserId: app.ownerId,
        details: {
          applicationId: id,
          businessName: app.businessInformation?.businessName,
          shopId: app.shopId,
        },
        level: 'CRITICAL',
      });
    } catch (e) {
      console.error('[suspend] audit logging warning:', e.message);
    }

    return result;
  }

  /**
   * FEATURE 6: Bulk verification action - mark documents as verified
   */
  async markDocumentsVerified(applicationIds, adminId) {
    if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
      throw new ApiError('Application IDs array required', 400);
    }

    const results = { successful: 0, failed: [] };

    for (const appId of applicationIds) {
      try {
        const app = await sellerAppRepository.findById(appId);
        if (!app) {
          results.failed.push({ applicationId: appId, error: 'Not found' });
          continue;
        }

        const updated = await sellerAppRepository.updateById(appId, {
          verificationStatus: {
            ...(app.verificationStatus || {}),
            documentsVerified: true,
          },
          statusTimeline: [
            ...(app.statusTimeline || []),
            {
              status: app.status,
              changedBy: adminId,
              changedAt: new Date(),
              reason: 'Documents verified by admin',
            },
          ],
        });

        results.successful++;

        try {
          await auditService.logAction({
            action: 'SELLER_DOCUMENTS_VERIFIED',
            adminId,
            targetUserId: app.ownerId,
            details: { applicationId: appId },
            level: 'INFO',
          });
        } catch (e) {
          console.error(`[markDocumentsVerified] audit logging warning:`, e.message);
        }
      } catch (error) {
        results.failed.push({ applicationId: appId, error: error.message });
      }
    }

    return results;
  }

  /**
   * FEATURE 7: Get application timeline/history
   */
  async getApplicationTimeline(applicationId) {
    const app = await sellerAppRepository.findById(applicationId);
    if (!app) throw new ApiError('Application not found', 404);

    return {
      applicationId,
      ownerId: app.ownerId,
      timeline: app.statusTimeline || [],
      currentStatus: app.status,
      totalEvents: (app.statusTimeline || []).length,
    };
  }
}

module.exports = new SellerApplicationService();