const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/create-new-conversation', authenticate, chatController.createConversation);
router.post('/create', authenticate, chatController.createConversation); // frontend compat
router.get('/get-all-conversation-seller/:id', authenticate, chatController.getSellerConversations);
router.get('/get-all-conversation-user/:id', authenticate, chatController.getUserConversations);
router.get('/customer/:id', authenticate, chatController.getUserConversations); // frontend compat
router.get('/seller/:id', authenticate, chatController.getSellerConversations); // frontend compat
router.put('/update-last-message/:id', authenticate, chatController.updateLastMessage);

module.exports = router;
