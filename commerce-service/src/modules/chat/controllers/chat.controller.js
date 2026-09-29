const chatService = require('../services/chat.service');
const { ok, created } = require('../../../shared/utils/response');
const { isAdmin, normalizeRole } = require('../../../shared/utils/roles');

// Every chat handler is scoped to the caller: a conversation can only be read
// or written by its members (an admin may read any). Listing another account's
// conversations by id and reading a conversation's messages with no membership
// check were both open to any authenticated caller.
function denyNotOwned() {
  const err = new Error('Forbidden: you can only access your own conversations');
  err.statusCode = 403;
  err.code = 'RESOURCE_NOT_OWNED';
  return err;
}

function assertOwnConversationList(req) {
  if (isAdmin(req.user && req.user.role)) return;
  if (!req.user || String(req.params.id) !== String(req.user.id)) throw denyNotOwned();
}

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
  } catch (err) { return next(err); }
}
async function getSellerConversations(req, res, next) {
  try {
    assertOwnConversationList(req);
    return ok(res, { conversations: await chatService.getConversationsByMember(req.params.id) });
  }
  catch (err) { return next(err); }
}
async function getUserConversations(req, res, next) {
  try {
    assertOwnConversationList(req);
    return ok(res, { conversations: await chatService.getConversationsByMember(req.params.id) });
  }
  catch (err) { return next(err); }
}
async function updateLastMessage(req, res, next) {
  try {
    await chatService.assertParticipant(req.params.id, req.user);
    return ok(res, { conversation: await chatService.updateConversationLastMessage(req.params.id, req.body) });
  }
  catch (err) { return next(err); }
}

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
      images, conversationId: req.body.conversationId, text: req.body.text, sender: req.user.id,
    });
    return created(res, { message });
  } catch (err) { return next(err); }
}
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
    return ok(res, { messages: await chatService.getMessagesByConversation(req.params.id) });
  } catch (err) { return next(err); }
}

module.exports = {
  createConversation,
  getSellerConversations,
  getUserConversations,
  updateLastMessage,
  createMessage,
  getAllMessages,
};
