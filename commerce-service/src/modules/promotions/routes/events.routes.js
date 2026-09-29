const express = require('express');
const router = express.Router();
const eventsController = require('../controllers/events.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { upload } = require('../../../app/config/upload');

router.post('/create-event', authenticate, authorize('SELLER'), upload.array('images'), eventsController.createEvent);
router.get('/get-all-events/:id', eventsController.getShopEvents);
router.delete('/delete-shop-event/:id', authenticate, authorize('SELLER'), eventsController.deleteEvent);
router.get('/get-all-events', eventsController.getAllEvents);

module.exports = router;
