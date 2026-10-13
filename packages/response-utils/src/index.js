/**
 * Standardized API response formatting
 */

class ResponseFormatter {
  /**
   * Success response (200 OK)
   */
  static ok(data = null, message = 'Success') {
    return {
      success: true,
      statusCode: 200,
      message,
      data
    };
  }

  /**
   * Created response (201 Created)
   */
  static created(data, message = 'Resource created') {
    return {
      success: true,
      statusCode: 201,
      message,
      data
    };
  }

  /**
   * No content response (204 No Content)
   */
  static noContent() {
    return {
      success: true,
      statusCode: 204,
      message: 'No content'
    };
  }

  /**
   * Bad request (400 Bad Request)
   */
  static badRequest(message, errors = null) {
    return {
      success: false,
      statusCode: 400,
      message,
      errors
    };
  }

  /**
   * Unauthorized (401 Unauthorized)
   */
  static unauthorized(message = 'Unauthorized') {
    return {
      success: false,
      statusCode: 401,
      message
    };
  }

  /**
   * Forbidden (403 Forbidden)
   */
  static forbidden(message = 'Forbidden') {
    return {
      success: false,
      statusCode: 403,
      message
    };
  }

  /**
   * Not found (404 Not Found)
   */
  static notFound(message = 'Resource not found') {
    return {
      success: false,
      statusCode: 404,
      message
    };
  }

  /**
   * Conflict (409 Conflict)
   */
  static conflict(message, data = null) {
    return {
      success: false,
      statusCode: 409,
      message,
      data
    };
  }

  /**
   * Server error (500 Internal Server Error)
   */
  static serverError(message = 'Internal server error') {
    return {
      success: false,
      statusCode: 500,
      message
    };
  }

  /**
   * Send response with status code
   */
  static send(res, response) {
    const statusCode = response.statusCode || 200;
    return res.status(statusCode).json(response);
  }

  /**
   * Format paginated response
   */
  static paginated(items, page, limit, total) {
    return {
      success: true,
      statusCode: 200,
      data: items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasMore: page * limit < total
      }
    };
  }

  /**
   * Format list response
   */
  static list(items, total = null) {
    return {
      success: true,
      statusCode: 200,
      data: items,
      count: items.length,
      total: total || items.length
    };
  }
}

module.exports = ResponseFormatter;
