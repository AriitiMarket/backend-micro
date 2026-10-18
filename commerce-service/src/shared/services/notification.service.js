const nodemailer = require('nodemailer');

/**
 * FIX #10: Notification Service
 * Handles email notifications for order status, disputes, price drops
 */
class NotificationService {
  constructor() {
    this.emailClient = this._initializeEmailClient();
  }

  _initializeEmailClient() {
    // Support multiple email providers
    const emailProvider = process.env.EMAIL_PROVIDER || 'smtp';
    
    if (emailProvider === 'smtp') {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'localhost',
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        } : undefined
      });
    } else if (emailProvider === 'sendgrid') {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      return { send: sgMail.send.bind(sgMail) };
    }
    
    return null;
  }

  /**
   * Send order status update notification
   */
  async notifyOrderStatus(order, previousStatus, newStatus, buyerEmail) {
    if (!this.emailClient || !buyerEmail) return;
    
    const messages = {
      'PROCESSING': 'Your order has been received and is being processed',
      'CONFIRMED': 'Your order has been confirmed by the seller',
      'SHIPPED': 'Your order has been shipped',
      'IN_TRANSIT': 'Your order is in transit',
      'DELIVERED': 'Your order has been delivered',
      'CANCELLED': 'Your order has been cancelled'
    };

    const statusMessage = messages[newStatus] || `Status changed to ${newStatus}`;

    try {
      await this.emailClient.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@aritii.com',
        to: buyerEmail,
        subject: `Order #${order._id} - ${statusMessage}`,
        html: `
          <h2>Order Update</h2>
          <p>Your order <strong>#${order._id}</strong> status has changed.</p>
          <p><strong>Previous Status:</strong> ${previousStatus}</p>
          <p><strong>New Status:</strong> ${newStatus}</p>
          <p><strong>Total Amount:</strong> ETB ${order.totalPrice}</p>
          <p><a href="${process.env.FRONTEND_URL}/orders/${order._id}">View Order Details</a></p>
          <p>Thank you for shopping with Aritii!</p>
        `
      });
      console.log(`Order status notification sent to ${buyerEmail}`);
    } catch (err) {
      console.error(`Failed to send order notification: ${err.message}`);
    }
  }

  /**
   * Send dispute resolution notification
   */
  async notifyDisputeResolution(dispute, resolution, buyerEmail, sellerEmail) {
    if (!this.emailClient) return;

    const statusMessages = {
      'RESOLVED': 'Your dispute has been resolved',
      'REJECTED': 'Your dispute was rejected',
      'CLOSED': 'Your dispute was closed'
    };

    const message = statusMessages[resolution.status] || 'Your dispute has been updated';

    const emailContent = `
      <h2>Dispute Update</h2>
      <p>Dispute <strong>#${dispute._id}</strong> has been ${resolution.status.toLowerCase()}.</p>
      <p><strong>Decision:</strong> ${resolution.decision || 'Pending'}</p>
      <p><strong>Resolution:</strong> ${resolution.resolution || 'No details provided'}</p>
      <p><a href="${process.env.FRONTEND_URL}/disputes/${dispute._id}">View Dispute Details</a></p>
    `;

    try {
      if (buyerEmail) {
        await this.emailClient.sendMail({
          from: process.env.EMAIL_FROM || 'noreply@aritii.com',
          to: buyerEmail,
          subject: `Dispute #${dispute._id} - ${message}`,
          html: emailContent
        });
      }

      if (sellerEmail) {
        await this.emailClient.sendMail({
          from: process.env.EMAIL_FROM || 'noreply@aritii.com',
          to: sellerEmail,
          subject: `Dispute #${dispute._id} - ${message}`,
          html: emailContent
        });
      }

      console.log('Dispute notification sent');
    } catch (err) {
      console.error(`Failed to send dispute notification: ${err.message}`);
    }
  }

  /**
   * Send payment confirmation
   */
  async notifyPaymentConfirmed(order, buyerEmail) {
    if (!this.emailClient || !buyerEmail) return;

    try {
      await this.emailClient.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@aritii.com',
        to: buyerEmail,
        subject: `Order #${order._id} - Payment Confirmed`,
        html: `
          <h2>Payment Confirmed</h2>
          <p>Your payment for order <strong>#${order._id}</strong> has been confirmed.</p>
          <p><strong>Amount:</strong> ETB ${order.totalPrice}</p>
          <p><strong>Payment Status:</strong> ${order.paymentStatus}</p>
          <p>Your order will be processed shortly.</p>
          <p><a href="${process.env.FRONTEND_URL}/orders/${order._id}">Track Order</a></p>
        `
      });
      console.log(`Payment confirmation sent to ${buyerEmail}`);
    } catch (err) {
      console.error(`Failed to send payment notification: ${err.message}`);
    }
  }

  /**
   * Send application status update
   */
  async notifyApplicationStatus(application, status, email, reason = '') {
    if (!this.emailClient || !email) return;

    const messages = {
      'APPROVED': 'Your seller application has been APPROVED! You can now start selling.',
      'REJECTED': 'Your seller application has been rejected.',
      'REQUESTING_INFO': 'We need more information about your application.'
    };

    try {
      await this.emailClient.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@aritii.com',
        to: email,
        subject: `Seller Application - ${status}`,
        html: `
          <h2>Application Status Update</h2>
          <p>${messages[status] || `Your application status: ${status}`}</p>
          ${reason ? `<p><strong>Details:</strong> ${reason}</p>` : ''}
          <p><a href="${process.env.FRONTEND_URL}/seller-application">View Application</a></p>
        `
      });
      console.log(`Application status notification sent to ${email}`);
    } catch (err) {
      console.error(`Failed to send application notification: ${err.message}`);
    }
  }

  /**
   * Send review moderation update
   */
  async notifyReviewModerationUpdate(review, status, buyerEmail) {
    if (!this.emailClient || !buyerEmail) return;

    const messages = {
      'APPROVED': 'Your review has been approved and is now visible',
      'REJECTED': 'Your review was not approved'
    };

    try {
      await this.emailClient.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@aritii.com',
        to: buyerEmail,
        subject: `Review Moderation Update`,
        html: `
          <h2>Review Status</h2>
          <p>${messages[status] || `Your review status: ${status}`}</p>
          <p><strong>Product:</strong> ${review.productName}</p>
          <p><strong>Your Rating:</strong> ${review.rating}/5 stars</p>
          <p><a href="${process.env.FRONTEND_URL}/my-reviews">View My Reviews</a></p>
        `
      });
      console.log(`Review moderation notification sent to ${buyerEmail}`);
    } catch (err) {
      console.error(`Failed to send review notification: ${err.message}`);
    }
  }
}

module.exports = new NotificationService();
