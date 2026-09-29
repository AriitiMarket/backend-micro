/**
 * Chat Module Tests (merged conversations + messages)
 *
 * Uses Node's built-in test runner (`node --test`) against a dedicated test DB.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const { describe, it, before, after, afterEach } = require('node:test');

let Conversation;
let Message;
let repo;
let service;

// Dedicated DB so this suite can run in parallel with the other suites.
const DB_URL = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/?]+(\?.*)?$/, '/ariti_commerce_test_chat$1')
  : 'mongodb://localhost:27017/ariti_commerce_test_chat';

const CUSTOMER = '507f1f77bcf86cd799439001';
const SELLER = '507f1f77bcf86cd799439002';
const STRANGER = '507f1f77bcf86cd799439003';

before(async () => {
  await mongoose.connect(DB_URL);
  Conversation = require('../models/Conversation');
  Message = require('../models/Message');
  await Promise.all([Conversation.deleteMany({}), Message.deleteMany({})]);
  await Promise.all([Conversation.init(), Message.init()]);
  repo = require('../repositories/chat.repository');
  service = require('../services/chat.service');
});

after(async () => { await mongoose.disconnect(); });
afterEach(async () => { await Promise.all([Conversation.deleteMany({}), Message.deleteMany({})]); });

describe('Chat Service', () => {
  it('builds conversation members from buyerId + sellerId', async () => {
    const conversation = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER, name: 'Order chat' });
    assert.deepStrictEqual(conversation.members, [CUSTOMER, SELLER]);
    assert.strictEqual(conversation.name, 'Order chat');
  });

  it('drops missing members instead of storing undefined', async () => {
    const conversation = await service.createConversation({ sellerId: SELLER });
    assert.deepStrictEqual(conversation.members, [SELLER]);
  });

  it('lists conversations for a member only', async () => {
    await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER, name: 'A' });
    const forCustomer = await service.getConversationsByMember(CUSTOMER);
    const forStranger = await service.getConversationsByMember(STRANGER);
    assert.strictEqual(forCustomer.length, 1);
    assert.strictEqual(forStranger.length, 0);
  });

  it('updates and returns the conversation preview', async () => {
    const conversation = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER });
    const updated = await service.updateConversationLastMessage(conversation._id, { lastMessage: 'hello', lastMessageId: 'm1' });
    assert.strictEqual(updated.lastMessage, 'hello');
    assert.strictEqual(updated.lastMessageId, 'm1');
  });

  it('normalizes sender/senderId and defaults images on create', async () => {
    const conversation = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER });
    const message = await service.createMessage({
      conversationId: String(conversation._id),
      text: 'hi',
      senderId: CUSTOMER,
      images: [{ public_id: 'p', url: '/uploads/p.jpg' }],
    });
    assert.strictEqual(message.sender, CUSTOMER);
    assert.strictEqual(message.text, 'hi');
    assert.strictEqual(message.images.length, 1);
  });

  it('stores the display name and the structured-card fields', async () => {
    const conversation = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER });
    const message = await service.createMessage({
      conversationId: String(conversation._id),
      text: 'hi',
      sender: CUSTOMER,
      senderName: 'Buyer',
      label: 'Product Reference',
    });
    assert.strictEqual(message.senderName, 'Buyer');
    assert.strictEqual(message.label, 'Product Reference');
    // Structured commerce cards default to an ordinary text bubble.
    assert.strictEqual(message.type, 'text');
    assert.strictEqual(message.payload, null);
    assert.strictEqual(message.replyTo, null);
  });

  it('reads messages back by conversation id', async () => {
    const conversation = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER });
    await service.createMessage({ conversationId: String(conversation._id), text: 'one', sender: CUSTOMER });
    await service.createMessage({ conversationId: String(conversation._id), text: 'two', sender: SELLER });
    const messages = await service.getMessagesByConversation(String(conversation._id));
    assert.strictEqual(messages.length, 2);
    assert.deepStrictEqual(messages.map((m) => m.text).sort(), ['one', 'two']);
  });

  it('does not leak messages across conversations', async () => {
    const a = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER });
    const b = await service.createConversation({ buyerId: STRANGER, sellerId: SELLER });
    await service.createMessage({ conversationId: String(a._id), text: 'private', sender: CUSTOMER });
    const messages = await service.getMessagesByConversation(String(b._id));
    assert.strictEqual(messages.length, 0);
  });
});

describe('Chat Repository', () => {
  it('finds a conversation by group title', async () => {
    const conversation = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER, name: 'A' });
    await repo.createConversation({ groupTitle: 'title-1', members: [CUSTOMER] });
    const found = await repo.findConversationByGroupTitle('title-1');
    assert.strictEqual(String(found._id).length > 0, true);
    assert.notStrictEqual(String(found._id), String(conversation._id));
  });

  it('sorts conversations newest first', async () => {
    const first = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER, name: 'old' });
    await new Promise((r) => setTimeout(r, 15));
    const second = await service.createConversation({ buyerId: CUSTOMER, sellerId: SELLER, name: 'new' });
    await service.updateConversationLastMessage(second._id, { lastMessage: 'x', lastMessageId: 'm' });
    const list = await service.getConversationsByMember(CUSTOMER);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(String(list[0]._id), String(second._id));
    assert.strictEqual(String(list[1]._id), String(first._id));
  });
});
