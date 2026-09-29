const settingsService = require('../services/settings.service');
const { ok } = require('../../../shared/utils/response');
const { sendAudit, ACTIONS, getAdminFromReq } = require('../../../shared/utils/audit-client');

async function getPlatformSettings(req, res, next) {
  try {
    const settings = await settingsService.getPlatformSettings();
    return ok(res, settings);
  } catch (err) { return next(err); }
}

async function updatePlatformSettings(req, res, next) {
  try {
    const oldSettings = await settingsService.getPlatformSettings();
    const settings = await settingsService.updatePlatformSettings(req.body);
    sendAudit({
      action: ACTIONS.PLATFORM_SETTINGS_CHANGED,
      ...getAdminFromReq(req),
      module: 'settings',
      targetEntity: 'platform_settings',
      targetId: 'platform',
      previousValue: oldSettings,
      newValue: settings,
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

module.exports = {
  getPlatformSettings,
  updatePlatformSettings,
  getNotificationSettings,
  updateNotificationSettings,
  getSystemSettings,
  updateSystemSettings,
};
