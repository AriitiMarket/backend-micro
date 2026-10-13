/**
 * Date range filtering utility
 * Handles custom date range filters for analytics
 */

class DateRangeFilter {
  /**
   * Build MongoDB date filter
   */
  static build(startDate, endDate, fieldName = 'createdAt') {
    const filter = {};
    if (!startDate && !endDate) return filter;

    filter[fieldName] = {};
    if (startDate) filter[fieldName].$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999); // Include full day
      filter[fieldName].$lte = end;
    }
    return filter;
  }

  /**
   * Get predefined date ranges
   */
  static getPredefinedRange(type) {
    const now = new Date();
    const ranges = {
      'today': {
        start: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        end: new Date()
      },
      'week': {
        start: new Date(now.setDate(now.getDate() - 7)),
        end: new Date()
      },
      'month': {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date()
      },
      'quarter': {
        start: new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1),
        end: new Date()
      },
      'year': {
        start: new Date(now.getFullYear(), 0, 1),
        end: new Date()
      }
    };
    return ranges[type];
  }

  /**
   * Validate date range
   */
  static validate(startDate, endDate) {
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      throw new Error('Start date must be before end date');
    }
  }
}

module.exports = DateRangeFilter;
