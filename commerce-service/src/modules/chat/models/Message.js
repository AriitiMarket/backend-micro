const mongoose = require('mongoose');

/**
 * A message in a conversation.
 *
 * Beside plain chat (`type: 'text'`) the request thread also carries structured
 * commerce events rendered as cards by the client: the buyer's product
 * requirement, every offer/counter-offer, and the final agreement. Those rows
 * are written by the request service with `type` + `payload` and are still
 * messages — they flow through the same pagination, realtime fan-out and
 * history as anything else.
 */
const MESSAGE_TYPES = ['text', 'requirement', 'offer', 'counter', 'agreement', 'system'];

const messagesSchema = new mongoose.Schema(
  {
    conversationId: { type: String },
    text: { type: String },
    sender: { type: String },
    senderName: { type: String },
    images: [{ public_id: { type: String }, url: { type: String } }],
    /** Card kind; 'text' is an ordinary chat bubble. */
    type: { type: String, enum: MESSAGE_TYPES, default: 'text' },
    /** Card body (offer snapshot, requirement snapshot, agreement terms…). */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Snapshot of the message this one replies to (trusted, server-built). */
    replyTo: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Optional caption for image posts, e.g. "Product Reference". */
    label: { type: String, default: '', maxlength: 60 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Messages', messagesSchema);
module.exports.MESSAGE_TYPES = MESSAGE_TYPES;
