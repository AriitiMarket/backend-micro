const chatRepository = require('../repositories/chat.repository');
const { normalizeRole } = require('../../../shared/utils/roles');

function chatError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

class ChatService {
  // --- conversations ---
  createConversation({ sellerId, buyerId, name }) {
    const members = [buyerId, sellerId].filter(Boolean);
    return chatRepository.createConversation({ members, name });
  }
  getConversationsByMember(id) { return chatRepository.findConversationsByMember(id); }

  /**
   * Load a conversation only when `user` is one of its members (an admin may
   * read any). Every chat read/write goes through this: without it any
   * authenticated account could read anyone's messages by id (IDOR). The
   * denial is 403 RESOURCE_NOT_OWNED so the client can tell it apart from a
   * genuinely missing conversation.
   */
  async assertParticipant(conversationId, user = {}) {
    const conversation = await chatRepository.findConversationById(conversationId);
    if (!conversation) throw chatError('Conversation not found', 404, 'NOT_FOUND');
    if (normalizeRole(user.role) === 'ADMIN') return conversation;
    const members = (conversation.members || []).map(String);
    if (!user.id || !members.includes(String(user.id))) {
      throw chatError('Forbidden: you are not a participant of this conversation', 403, 'RESOURCE_NOT_OWNED');
    }
    return conversation;
  }

  /** Messages of every conversation shared by exactly these two accounts. */
  getMessagesBetween(a, b) {
    return chatRepository
      .findConversationsByMembers([a, b])
      .then((conversations) => chatRepository.findMessagesByConversations(conversations.map((c) => c.id)));
  }
  updateConversationLastMessage(id, { lastMessage, lastMessageId }) {
    return chatRepository.updateConversationLastMessage(id, lastMessage, lastMessageId);
  }

  // --- messages ---
  createMessage(data) {
    const messageData = {
      conversationId: data.conversationId,
      text: data.text,
      sender: data.sender || data.senderId,
      senderName: data.senderName,
      images: data.images || [],
      // Structured commerce cards (requirement/offer/counter/agreement) and
      // reply/label metadata ride along with ordinary chat rows.
      type: data.type || 'text',
      payload: data.payload === undefined ? null : data.payload,
      replyTo: data.replyTo === undefined ? null : data.replyTo,
      label: data.label || '',
    };
    return chatRepository.createMessage(messageData);
  }
  getMessagesByConversation(conversationId) {
    return chatRepository.findMessagesByConversation(conversationId);
  }
  /** Lookup used to build a trusted reply snapshot (never client-supplied). */
  getMessageById(id) { return chatRepository.findMessageById(id); }
}

module.exports = new ChatService();
