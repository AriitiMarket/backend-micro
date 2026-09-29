const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

class ChatRepository {
  // --- conversations ---
  createConversation(data) { return Conversation.create(data); }
  findConversationByGroupTitle(groupTitle) { return Conversation.findOne({ groupTitle }); }
  findConversationById(id) {
    if (!id) return Promise.resolve(null);
    try {
      const { isValidObjectId } = require('../../../shared/utils/mongoId');
      if (!isValidObjectId(id)) return Promise.resolve(null);
    } catch (err) { return Promise.resolve(null); }
    return Conversation.findById(id);
  }
  /** Conversations whose member list contains every given id. */
  findConversationsByMembers(ids) {
    const list = (ids || []).map(String).filter(Boolean);
    if (list.length === 0) return Promise.resolve([]);
    return Conversation.find({ members: { $all: list } });
  }
  findConversationsByMember(id) {
    return Conversation.find({ members: { $in: [id] } }).sort({ updatedAt: -1, createdAt: -1 });
  }
  updateConversationLastMessage(id, lastMessage, lastMessageId) {
    return Conversation.findByIdAndUpdate(id, { lastMessage, lastMessageId }, { new: true });
  }

  // --- messages ---
  createMessage(data) { return Message.create(data); }
  findMessagesByConversation(conversationId) { return Message.find({ conversationId }); }
  findMessagesByConversations(conversationIds) {
    const list = (conversationIds || []).map(String).filter(Boolean);
    if (list.length === 0) return Promise.resolve([]);
    return Message.find({ conversationId: { $in: list } });
  }
  findMessageById(id) {
    if (!id) return Promise.resolve(null);
    try {
      const { isValidObjectId } = require('../../../shared/utils/mongoId');
      if (!isValidObjectId(id)) return Promise.resolve(null);
    } catch (err) { return Promise.resolve(null); }
    return Message.findById(id);
  }
}

module.exports = new ChatRepository();
