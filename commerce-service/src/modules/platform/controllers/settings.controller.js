const settingsService = require('../services/settings.service');
const SettingsAudit = require('../models/SettingsAudit');
const { ok } = require('../../../shared/utils/response');
const { sendAudit, ACTIONS, getAdminFromReq } = require('../../../shared/utils/audit-client');

async function getPlatformSettings(req, res, next) {
  try {
    const settings = await settingsService.getPlatformSettings();
    return ok(res, settings);
  } catch (err) { return next(err); }
}

async function getPlatformSettingsAudit(req, res, next) {
  try {
    const history = await SettingsAudit.find({
      key: 'platform',
      field: { $in: ['commissionRate', 'categoryCommissions', 'sellerCommissionVariations', 'sellerCommissionRates'] },
    }).sort({ changedAt: -1 }).limit(100).lean();
    return ok(res, history);
  } catch (err) { return next(err); }
}

async function updatePlatformSettings(req, res, next) {
  try {
    const oldSettings = await settingsService.getPlatformSettings();
    const { reason, ...settingsInput } = req.body || {};
    const commissionFields = ['commissionRate', 'categoryCommissions', 'sellerCommissionVariations', 'sellerCommissionRates'];
    const changedCommissionFields = commissionFields.filter((field) =>
      settingsInput[field] !== undefined && JSON.stringify(oldSettings[field]) !== JSON.stringify(settingsInput[field])
    );
    if (changedCommissionFields.length && (typeof reason !== 'string' || !reason.trim())) {
      const err = new Error('Reason required for commission changes'); err.statusCode = 422; throw err;
    }
    const settings = await settingsService.updatePlatformSettings(settingsInput);
    const admin = getAdminFromReq(req);
    for (const field of changedCommissionFields) {
      await SettingsAudit.create({
        key: 'platform', field,
        oldValue: oldSettings[field], newValue: settings[field],
        changedBy: admin.adminId || null,
        changedByRole: admin.actorRole || 'ADMIN',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        reason: reason.trim(),
      });
    }
    sendAudit({
      action: ACTIONS.PLATFORM_SETTINGS_CHANGED,
      ...admin,
      module: 'settings',
      targetEntity: 'platform_settings',
      targetId: 'platform',
      previousValue: oldSettings,
      newValue: settings,
      reason: reason || undefined,
    });
    return ok(res, settings, 'Platform settings updated');
  } catch (err) { return next(err); }
}

async function getNotificationSettings(req, res, next) {
  try {
    const settings = await settingsService.getNotificationSettings();
    return ok(res, settings);
  } catch (err) { return next(err); }
}

async function updateNotificationSettings(req, res, next) {
  try {
    const oldSettings = await settingsService.getNotificationSettings();
    const settings = await settingsService.updateNotificationSettings(req.body);
    sendAudit({
      action: ACTIONS.SETTINGS_CHANGED,
      ...getAdminFromReq(req),
      module: 'settings',
      targetEntity: 'notification_settings',
      targetId: 'notifications',
      previousValue: oldSettings,
      newValue: settings,
    });
    return ok(res, settings, 'Notification settings updated');
  } catch (err) { return next(err); }
}

async function getSystemSettings(req, res, next) {
  try {
    const settings = await settingsService.getSystemSettings();
    return ok(res, settings);
  } catch (err) { return next(err); }
}

async function updateSystemSettings(req, res, next) {
  try {
    const oldSettings = await settingsService.getSystemSettings();
    const settings = await settingsService.updateSystemSettings(req.body);
    sendAudit({
      action: ACTIONS.SETTINGS_CHANGED,
      ...getAdminFromReq(req),
      module: 'settings',
      targetEntity: 'system_settings',
      targetId: 'system',
      previousValue: oldSettings,
      newValue: settings,
    });
    return ok(res, settings, 'System settings updated');
  } catch (err) { return next(err); }
}

async function getReportSettings(req, res, next) {
  try {
    const settings = await settingsService.getReportSettings();
    return ok(res, settings);
  } catch (err) { return next(err); }
}

async function updateReportSettings(req, res, next) {
  try {
    const oldSettings = await settingsService.getReportSettings();
    const settings = await settingsService.updateReportSettings(req.body);
    sendAudit({
      action: ACTIONS.SETTINGS_CHANGED,
      ...getAdminFromReq(req),
      module: 'settings',
      targetEntity: 'report_settings',
      targetId: 'reports',
      previousValue: oldSettings,
      newValue: settings,
    });
    return ok(res, settings, 'Report settings updated');
  } catch (err) { return next(err); }
}

module.exports = {
  getPlatformSettings,
  getPlatformSettingsAudit,
  updatePlatformSettings,
  getNotificationSettings,
  updateNotificationSettings,
  getSystemSettings,
  updateSystemSettings,
  getReportSettings,
  updateReportSettings,
};
