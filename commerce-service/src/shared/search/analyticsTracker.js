/**
 * Search analytics tracker
 * Tracks popular searches for insights
 */

const SearchAnalytics = require('../models/SearchAnalytics');

class SearchAnalyticsTracker {
  /**
   * Track search query
   */
  static async trackSearch(query, resultCount, userId = null) {
    try {
      await SearchAnalytics.create({
        query: query.toLowerCase().trim(),
        resultCount,
        userId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Search tracking failed:', error);
    }
  }

  /**
   * Get popular searches
   */
  static async getPopularSearches(limit = 20, days = 30) {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const searches = await SearchAnalytics.aggregate([
      {
        $match: { timestamp: { $gte: sinceDate } }
      },
      {
        $group: {
          _id: '$query',
          count: { $sum: 1 },
          avgResultCount: { $avg: '$resultCount' },
          lastSearched: { $max: '$timestamp' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: limit }
    ]);

    return searches;
  }

  /**
   * Get trending searches (increased popularity)
   */
  static async getTrendingSearches(limit = 10, days = 7) {
    const currentDate = new Date();
    const weekAgo = new Date(currentDate);
    weekAgo.setDate(weekAgo.getDate() - days);
    const twoWeeksAgo = new Date(currentDate);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - days * 2);

    const currentPeriod = await SearchAnalytics.aggregate([
      { $match: { timestamp: { $gte: weekAgo } } },
      { $group: { _id: '$query', count: { $sum: 1 } } }
    ]);

    const previousPeriod = await SearchAnalytics.aggregate([
      {
        $match: {
          timestamp: { $gte: twoWeeksAgo, $lt: weekAgo }
        }
      },
      { $group: { _id: '$query', count: { $sum: 1 } } }
    ]);

    const previousMap = new Map(previousPeriod.map(p => [p._id, p.count]));
    const trending = [];

    for (const item of currentPeriod) {
      const previousCount = previousMap.get(item._id) || 0;
      const percentChange = previousCount === 0 
        ? 100 
        : ((item.count - previousCount) / previousCount) * 100;

      if (percentChange > 20) { // At least 20% increase
        trending.push({
          query: item._id,
          currentCount: item.count,
          previousCount,
          percentChange: Math.round(percentChange)
        });
      }
    }

    return trending
      .sort((a, b) => b.percentChange - a.percentChange)
      .slice(0, limit);
  }

  /**
   * Get searches with no results (gaps)
   */
  static async getSearchGaps(limit = 10) {
    const searches = await SearchAnalytics.aggregate([
      { $match: { resultCount: 0 } },
      {
        $group: {
          _id: '$query',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: limit }
    ]);

    return searches;
  }

  /**
   * Get search session activity
   */
  static async getUserSearchHistory(userId, limit = 20) {
    return SearchAnalytics.find({ userId })
      .sort({ timestamp: -1 })
      .limit(limit);
  }
}

module.exports = SearchAnalyticsTracker;
