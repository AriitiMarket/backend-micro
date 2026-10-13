const PaymentMethod = require('../models/PaymentMethods');

class PaymentMethodService {
  /**
   * Add a new payment method
   */
  async addPaymentMethod(userId, methodData) {
    if (!userId) throw new Error('User ID required');
    
    // Validate method type
    const validTypes = ['CARD', 'MOBILE_WALLET', 'BANK_TRANSFER', 'COD', 'CRYPTO'];
    if (!validTypes.includes(methodData.methodType)) {
      throw new Error(`Invalid payment method type: ${methodData.methodType}`);
    }
    
    // If this is to be default, unset other defaults
    if (methodData.isDefault) {
      await PaymentMethod.updateMany(
        { userId, isDefault: true },
        { isDefault: false }
      );
    }
    
    const method = await PaymentMethod.create({
      userId,
      ...methodData
    });
    
    return method;
  }

  /**
   * Get all payment methods for user
   */
  async getUserPaymentMethods(userId) {
    return PaymentMethod.find({
      userId,
      status: { $ne: 'SUSPENDED' }
    }).sort({ isDefault: -1, createdAt: -1 });
  }

  /**
   * Get only active payment methods
   */
  async getActivePaymentMethods(userId) {
    return PaymentMethod.find({
      userId,
      status: 'ACTIVE',
      isVerified: true
    }).sort({ isDefault: -1 });
  }

  /**
   * Get default payment method
   */
  async getDefaultPaymentMethod(userId) {
    return PaymentMethod.findOne({
      userId,
      isDefault: true,
      status: 'ACTIVE'
    });
  }

  /**
   * Set payment method as default
   */
  async setAsDefault(userId, methodId) {
    const method = await PaymentMethod.findById(methodId);
    
    if (!method || method.userId !== userId) {
      throw new Error('Payment method not found');
    }
    
    // Unset other defaults
    await PaymentMethod.updateMany(
      { userId, isDefault: true },
      { isDefault: false }
    );
    
    // Set this as default
    return PaymentMethod.findByIdAndUpdate(
      methodId,
      { isDefault: true },
      { new: true }
    );
  }

  /**
   * Verify payment method (after first successful transaction)
   */
  async verifyPaymentMethod(methodId) {
    return PaymentMethod.findByIdAndUpdate(
      methodId,
      {
        isVerified: true,
        verifiedAt: new Date(),
        failureCount: 0
      },
      { new: true }
    );
  }

  /**
   * Mark payment method as failed
   */
  async recordFailure(methodId) {
    const method = await PaymentMethod.findById(methodId);
    if (!method) return null;
    
    const newFailureCount = (method.failureCount || 0) + 1;
    const newStatus = newFailureCount > 3 ? 'SUSPENDED' : method.status;
    
    return PaymentMethod.findByIdAndUpdate(
      methodId,
      {
        failureCount: newFailureCount,
        status: newStatus
      },
      { new: true }
    );
  }

  /**
   * Record successful transaction
   */
  async recordSuccess(methodId) {
    return PaymentMethod.findByIdAndUpdate(
      methodId,
      {
        lastUsed: new Date(),
        failureCount: 0,
        isVerified: true,
        verifiedAt: new Date()
      },
      { new: true }
    );
  }

  /**
   * Delete payment method
   */
  async deletePaymentMethod(userId, methodId) {
    const method = await PaymentMethod.findById(methodId);
    
    if (!method || method.userId !== userId) {
      throw new Error('Payment method not found');
    }
    
    if (method.isDefault) {
      throw new Error('Cannot delete default payment method');
    }
    
    return PaymentMethod.findByIdAndDelete(methodId);
  }

  /**
   * Get payment method by type for user
   */
  async getMethodByType(userId, methodType) {
    return PaymentMethod.find({
      userId,
      methodType,
      status: 'ACTIVE'
    });
  }

  /**
   * Validate payment method is available for delivery area
   */
  async validateMethodForArea(methodId, areaId) {
    const method = await PaymentMethod.findById(methodId);
    
    if (!method) return false;
    if (method.status !== 'ACTIVE') return false;
    
    // COD only available in certain areas
    if (method.methodType === 'COD') {
      return method.cod?.availableInAreas?.includes(areaId) || false;
    }
    
    return true;
  }

  /**
   * Get payment statistics for user
   */
  async getPaymentStats(userId) {
    const methods = await PaymentMethod.find({ userId });
    
    return {
      totalMethods: methods.length,
      verifiedMethods: methods.filter(m => m.isVerified).length,
      activeMethods: methods.filter(m => m.status === 'ACTIVE').length,
      byType: this._groupByType(methods)
    };
  }

  _groupByType(methods) {
    const grouped = {};
    for (const method of methods) {
      grouped[method.methodType] = (grouped[method.methodType] || 0) + 1;
    }
    return grouped;
  }
}

module.exports = new PaymentMethodService();
