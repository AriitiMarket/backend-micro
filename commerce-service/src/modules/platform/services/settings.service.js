const settingsRepository = require('../repositories/settings.repository');

const DEFAULT_PLATFORM_SETTINGS = {
  platformName: 'Aritii Marketplace',
  platformDescription: 'Multi-vendor marketplace platform',
  supportEmail: 'support@aritii.com',
  supportPhone: '',
  marketplaceActive: true,
  registrationOpen: true,
  sellerRegistrationOpen: true,
  riderRegistrationOpen: true,
  commissionRate: 10,
  deliveryFee: 50,
  minOrderAmount: 100,
  maxOrderAmount: 50000,
  supportedCurrencies: ['USD', 'ETB'],
  defaultCurrency: 'ETB',
  taxRate: 0,
  sellerPayoutSchedule: 'weekly',
  autoApproveShops: false,
  autoApproveRiders: false,
  maxProductsPerSeller: 500,
  maxImagesPerProduct: 8,
  orderTimeoutMinutes: 30,
  cancellationWindowMinutes: 15,
  refundWindowDays: 7,
  defaultDeliveryZone: '',
  maxDeliveryDistanceKm: 50,
  expressDeliveryMultiplier: 1.5,
  minPayoutAmount: 500,
  payoutProcessingFeePercent: 1,
  settlementWindowDays: 7,
  payoutMethods: ['BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHECK'],
  categoryCommissions: [],
  sellerCommissionVariations: [],
  features: {
    wishlistEnabled: true,
    reviewsEnabled: true,
    chatEnabled: true,
    promotionsEnabled: true,
    couponsEnabled: true,
    subscriptionsEnabled: false,
    multiVendorEnabled: true,
  },
};

const DEFAULT_NOTIFICATION_SETTINGS = {
  emailNotificationsEnabled: true,
  smsNotificationsEnabled: false,
  pushNotificationsEnabled: true,
  orderCreated: true,
  orderDelivered: true,
  orderCancelled: true,
  riderAssigned: true,
  disputeRaised: true,
  reviewSubmitted: false,
  sellerApproved: true,
  sellerRejected: true,
  newSellerApplication: true,
  lowStockAlert: true,
  dailyDigestEnabled: false,
  weeklyReportEnabled: true,
};

const DEFAULT_SYSTEM_SETTINGS = {
  maintenanceMode: false,
  maintenanceMessage: 'System is under maintenance. Please try again later.',
  forceUpdateEnabled: false,
  apiRateLimitEnabled: true,
  maxRequestsPerMinute: 100,
  requestTimeoutMs: 30000,
  maxRetryAttempts: 3,
  loggingLevel: 'info',
  sessionTimeoutMinutes: 60,
  maxLoginAttempts: 5,
  lockoutDurationMinutes: 15,
  passwordMinLength: 8,
  requireEmailVerification: true,
  requirePhoneVerification: false,
};

const DEFAULT_REPORT_SETTINGS = {
  defaultReportingPeriod: '30D',
  defaultTimezone: 'UTC',
  defaultCurrency: 'ETB',
  supportedCurrencies: ['USD', 'ETB'],
  exportFormat: 'csv',
  availableFilters: ['dateRange', 'business', 'shop', 'status', 'paymentStatus'],
  reportRefreshMinutes: 60,
  dataFreshnessWarningMinutes: 120,
  reportAccessPermissions: ['ADMIN', 'SELLER'],
};

class SettingsService {
  async getPlatformSettings() {
    try {
      const settings = await settingsRepository.findOne('platform');
      const data = settings?.value || DEFAULT_PLATFORM_SETTINGS;
      // Merge with defaults to ensure all fields exist
      return { ...DEFAULT_PLATFORM_SETTINGS, ...data, features: { ...DEFAULT_PLATFORM_SETTINGS.features, ...(data.features || {}) } };
    } catch (err) {
      console.error('Settings getPlatformSettings error:', err);
      return DEFAULT_PLATFORM_SETTINGS;
    }
  }

  async updatePlatformSettings(data) {
    try {
      const current = await this.getPlatformSettings();
      const merged = { ...current, ...data };

      // Validate commission rate
      if (data.commissionRate !== undefined) {
        merged.commissionRate = this._validateCommissionRate(data.commissionRate, 'commissionRate');
      }

      // Validate every configured override so malformed entries cannot
      // silently fall through to a different rate during order creation.
      for (const field of ['categoryCommissions', 'sellerCommissionVariations']) {
        if (data[field] === undefined) continue;
        if (!Array.isArray(data[field])) {
          const err = new Error(`${field} must be an array`); err.statusCode = 422; throw err;
        }
        merged[field] = data[field].map((entry, index) => {
          const hasScope = field === 'categoryCommissions'
            ? Boolean(entry?.categoryId || entry?.category)
            : Boolean(entry?.sellerId || entry?.sellerType);
          if (!hasScope) {
            const err = new Error(`${field}[${index}] requires a category or seller scope`); err.statusCode = 422; throw err;
          }
          return { ...entry, commission: this._validateCommissionRate(entry?.commission, `${field}[${index}].commission`) };
        });
      }
      if (data.sellerCommissionRates !== undefined) {
        if (!data.sellerCommissionRates || typeof data.sellerCommissionRates !== 'object' || Array.isArray(data.sellerCommissionRates)) {
          const err = new Error('sellerCommissionRates must be an object'); err.statusCode = 422; throw err;
        }
        merged.sellerCommissionRates = Object.fromEntries(Object.entries(data.sellerCommissionRates).map(([sellerId, rate]) => [
          sellerId, this._validateCommissionRate(rate, `sellerCommissionRates.${sellerId}`),
        ]));
      }

      // Validate min payout amount
      if (data.minPayoutAmount !== undefined) {
        const min = Number(data.minPayoutAmount);
        if (isNaN(min) || min < 0) {
          throw new Error('Minimum payout amount must be a positive number');
        }
        merged.minPayoutAmount = min;
      }

      // Validate payout processing fee percent
      if (data.payoutProcessingFeePercent !== undefined) {
        const fee = Number(data.payoutProcessingFeePercent);
        if (isNaN(fee) || fee < 0 || fee > 100) {
          throw new Error('Payout processing fee must be between 0 and 100');
        }
        merged.payoutProcessingFeePercent = fee;
      }

      // Validate settlement window days
      if (data.settlementWindowDays !== undefined) {
        const days = Number(data.settlementWindowDays);
        if (isNaN(days) || days < 0) {
          throw new Error('Settlement window days must be a positive number');
        }
        merged.settlementWindowDays = days;
      }

      // Validate payout methods
      if (data.payoutMethods !== undefined) {
        const allowed = ['BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHECK'];
        const invalid = data.payoutMethods.filter((m) => !allowed.includes(m));
        if (invalid.length > 0) {
          throw new Error(`Invalid payout methods: ${invalid.join(', ')}`);
        }
        merged.payoutMethods = data.payoutMethods;
      }

      if (data.features) {
        merged.features = { ...current.features, ...data.features };
      }

      return await settingsRepository.updateOrCreate('platform', merged);
    } catch (err) {
      console.error('Settings updatePlatformSettings error:', err);
      throw err;
    }
  }

  _validateCommissionRate(value, field) {
    const rate = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.round(rate * 100) !== rate * 100) {
      const err = new Error(`${field} must be a number from 0 to 100 with at most 2 decimal places`);
      err.statusCode = 422;
      throw err;
    }
    return rate;
  }

  async getNotificationSettings() {
    try {
      const settings = await settingsRepository.findOne('notifications');
      return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(settings?.value || {}) };
    } catch (err) {
      console.error('Settings getNotificationSettings error:', err);
      return DEFAULT_NOTIFICATION_SETTINGS;
    }
  }

  async updateNotificationSettings(data) {
    try {
      const current = await this.getNotificationSettings();
      const merged = { ...current, ...data };
      return await settingsRepository.updateOrCreate('notifications', merged);
    } catch (err) {
      console.error('Settings updateNotificationSettings error:', err);
      throw err;
    }
  }

  async getSystemSettings() {
    try {
      const settings = await settingsRepository.findOne('system');
      return { ...DEFAULT_SYSTEM_SETTINGS, ...(settings?.value || {}) };
    } catch (err) {
      console.error('Settings getSystemSettings error:', err);
      return DEFAULT_SYSTEM_SETTINGS;
    }
  }

  async updateSystemSettings(data) {
    try {
      const current = await this.getSystemSettings();
      const merged = { ...current, ...data };
      return await settingsRepository.updateOrCreate('system', merged);
    } catch (err) {
      console.error('Settings updateSystemSettings error:', err);
      throw err;
    }
  }

  async getReportSettings() {
    try {
      const settings = await settingsRepository.findOne('reports');
      return { ...DEFAULT_REPORT_SETTINGS, ...(settings?.value || {}) };
    } catch (err) {
      console.error('Settings getReportSettings error:', err);
      return DEFAULT_REPORT_SETTINGS;
    }
  }

  async updateReportSettings(data) {
    try {
      const current = await this.getReportSettings();
      const merged = { ...current, ...data };
      // Validate currency
      if (merged.defaultCurrency && !DEFAULT_REPORT_SETTINGS.supportedCurrencies.includes(merged.defaultCurrency)) {
        throw new Error(`Unsupported default currency: ${merged.defaultCurrency}`);
      }
      if (merged.exportFormat && !['csv', 'pdf'].includes(merged.exportFormat)) {
        throw new Error(`Unsupported export format: ${merged.exportFormat}`);
      }
      return await settingsRepository.updateOrCreate('reports', merged);
    } catch (err) {
      console.error('Settings updateReportSettings error:', err);
      throw err;
    }
  }
}

module.exports = new SettingsService();
