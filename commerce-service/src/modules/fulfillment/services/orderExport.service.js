const orderRepository = require('../repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderExportService {
  async exportOrdersAsCSV(filters = {}) {
    const orders = await orderRepository.find(filters);
    if (!orders || orders.length === 0) {
      throw new ApiError('No orders to export', 404);
    }

    const headers = ['Order ID', 'Date', 'Buyer', 'Total', 'Status', 'Items'];
    const rows = orders.map(order => [
      order._id,
      new Date(order.createdAt).toISOString().split('T')[0],
      order.user?.name || 'Unknown',
      order.totalPrice || 0,
      order.status,
      order.cart?.length || 0,
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    return {
      filename: `orders_${new Date().getTime()}.csv`,
      content: csv,
      mimeType: 'text/csv',
    };
  }

  async exportOrdersAsPDF(filters = {}) {
    const orders = await orderRepository.find(filters);
    if (!orders || orders.length === 0) {
      throw new ApiError('No orders to export', 404);
    }

    return {
      filename: `orders_${new Date().getTime()}.pdf`,
      data: orders,
      mimeType: 'application/pdf',
    };
  }

  async exportSingleOrderAsJSON(orderId) {
    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw new ApiError('Order not found', 404);
    }

    return {
      filename: `order_${orderId}.json`,
      content: JSON.stringify(order.toObject(), null, 2),
      mimeType: 'application/json',
    };
  }
}

module.exports = new OrderExportService();
