const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { upload } = require('../../../app/config/upload');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/create-new-message', authenticate, upload.array('images'), chatController.createMessage);
router.post('/create', authenticate, upload.array('images'), chatController.createMessage); // frontend compat
router.get('/get-all-messages/:id', authenticate, chatController.getAllMessages);
router.get('/:senderId/:receiverId', authenticate, chatController.getAllMessages); // frontend compat

module.exports = router;
