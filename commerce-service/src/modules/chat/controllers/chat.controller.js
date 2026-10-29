// Chat Controller — manages real-time messaging between buyers and sellers with strict conversation membership verification.
'use strict';

const chatService = require('../services/chat.service');
const { ok, created } = require('../../../shared/utils/response');
const { isAdmin, normalizeRole } = require('../../../shared/utils/roles');

/**
 * Generate a standard 403 Forbidden error for non-participant callers.
 * 
 * @returns {Error} Formatted error with status 403 and RESOURCE_NOT_OWNED code
 */
function denyNotOwned() {
  const err = new Error('Forbidden: you can only access your own conversations');
  err.statusCode = 403;
  err.code = 'RESOURCE_NOT_OWNED';
  return err;
}

/**
 * Ensure the authenticated user either owns the conversation list or possesses admin privileges.
 * 
 * @param {import('express').Request} req
 */
function assertOwnConversationList(req) {
  if (isAdmin(req.user && req.user.role)) return;
  if (!req.user || String(req.params.id) !== String(req.user.id)) {
    throw denyNotOwned();
  }
}

/**
 * Create a new conversation between a buyer and a seller.
 * The caller is guaranteed to be one participant and cannot spoof another sender.
 * 
 * @param {import('express').Request} req - Express request with conversation payload
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function createConversation(req, res, next) {
  try {
    const payload = { ...req.body };
    const role = normalizeRole(req.user && req.user.role);

    // The caller always becomes one side of the conversation — they can neither
    // open a chat "as" someone else nor exclude themselves from `members`.
    if (role === 'SELLER') {
      payload.sellerId = req.user.id;
    } else {
      payload.buyerId = req.user.id;
    }
    payload.sender = req.user.id;

    const conversation = await chatService.createConversation(payload);
    return created(res, { message: 'Conversation created successfully', conversation });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve all conversations where the authenticated seller is a participant.
 * 
 * @param {import('express').Request} req - Express request with params { id: sellerId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getSellerConversations(req, res, next) {
  try {
    assertOwnConversationList(req);
    const conversations = await chatService.getConversationsByMember(req.params.id);
    return ok(res, { conversations });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve all conversations where the authenticated user (buyer) is a participant.
 * 
 * @param {import('express').Request} req - Express request with params { id: userId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getUserConversations(req, res, next) {
  try {
    assertOwnConversationList(req);
    const conversations = await chatService.getConversationsByMember(req.params.id);
    return ok(res, { conversations });
  } catch (err) {
    return next(err);
  }
}

/**
 * Update the last message snapshot and unread activity for a conversation.
 * 
 * @param {import('express').Request} req - Express request with params { id: conversationId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function updateLastMessage(req, res, next) {
  try {
    await chatService.assertParticipant(req.params.id, req.user);
    const conversation = await chatService.updateConversationLastMessage(req.params.id, req.body || {});
    return ok(res, { conversation });
  } catch (err) {
    return next(err);
  }
}

/**
 * Send a new text or image message within an authorized conversation.
 * 
 * @param {import('express').Request} req - Express request with multipart files or body { conversationId, text, imageUrls }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function createMessage(req, res, next) {
  try {
    await chatService.assertParticipant(req.body.conversationId, req.user);

    let images = [];
    if (req.files && req.files.length > 0) {
      images = req.files.map((file) => ({ public_id: file.filename, url: file.path }));
    }

    if (req.body.imageUrls) {
      const raw = req.body.imageUrls;
      let urls = [];
      if (typeof raw === 'string') {
        urls = raw.split(',').map((u) => u.trim()).filter(Boolean);
      } else if (Array.isArray(raw)) {
        urls = raw.filter(Boolean);
      }
      const urlImages = urls.map((url) => ({ public_id: url, url }));
      images = [...images, ...urlImages];
    }

    const message = await chatService.createMessage({
      images,
      conversationId: req.body.conversationId,
      text: req.body.text,
      sender: req.user.id,
    });

    return created(res, { message });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve messages for a conversation or between two members (legacy shape).
 * 
 * @param {import('express').Request} req - Express request with params { id } or { senderId, receiverId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getAllMessages(req, res, next) {
  try {
    // Legacy shape /:senderId/:receiverId: only a participant of that pair may
    // read it (admin excepted). The pair has no conversation id of its own, so
    // the messages come from every conversation the two accounts share.
    if (req.params.senderId && req.params.receiverId) {
      if (!isAdmin(req.user && req.user.role)) {
        const uid = String(req.user.id);
        if (uid !== String(req.params.senderId) && uid !== String(req.params.receiverId)) {
          throw denyNotOwned();
        }
      }
      const messages = await chatService.getMessagesBetween(req.params.senderId, req.params.receiverId);
      return ok(res, { messages });
    }

    await chatService.assertParticipant(req.params.id, req.user);
    const messages = await chatService.getMessagesByConversation(req.params.id);
    return ok(res, { messages });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createConversation,
  getSellerConversations,
  getUserConversations,
  updateLastMessage,
  createMessage,
  getAllMessages,
};

