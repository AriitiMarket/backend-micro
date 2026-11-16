const express = require('express');
const router = express.Router();
const orderNotesController = require('../controllers/orderNotes.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.use(authenticate);

router.post('/', (req, res, next) => orderNotesController.createNote(req, res, next));
router.get('/', (req, res, next) => orderNotesController.getNotes(req, res, next));
router.get('/:orderId/display', (req, res, next) => orderNotesController.getNotesForDisplay(req, res, next));
router.patch('/:noteId/pin', (req, res, next) => orderNotesController.setPinned(req, res, next));
router.delete('/:noteId', (req, res, next) => orderNotesController.deleteNote(req, res, next));

module.exports = router;
