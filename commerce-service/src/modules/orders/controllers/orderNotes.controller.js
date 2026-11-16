const orderNotesService = require('../services/orderNotes.service');

class OrderNotesController {
  async createNote(req, res, next) {
    try {
      const userId = req.user?.id || req.user?._id;
      const userRole = req.user?.role;
      const { orderId, message, isPinned, isInternal } = req.body;

      if (!orderId || !message) {
        return res.status(400).json({ error: 'orderId and message required' });
      }

      const note = await orderNotesService.createNote(
        orderId,
        userId,
        userRole,
        message,
        { isPinned, isInternal }
      );

      res.status(201).json(note);
    } catch (err) {
      next(err);
    }
  }

  async getNotes(req, res, next) {
    try {
      const { orderId, limit = 50, offset = 0 } = req.query;

      if (!orderId) {
        return res.status(400).json({ error: 'orderId required' });
      }

      const notes = await orderNotesService.getNotes(orderId, {
        limit: Math.min(parseInt(limit), 100),
        offset: parseInt(offset),
      });

      const count = await orderNotesService.getNoteCount(orderId);

      res.json({
        notes,
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
    } catch (err) {
      next(err);
    }
  }

  async getNotesForDisplay(req, res, next) {
    try {
      const { orderId } = req.params;

      const notes = await orderNotesService.getNotesForDisplay(orderId);

      res.json({ notes });
    } catch (err) {
      next(err);
    }
  }

  async setPinned(req, res, next) {
    try {
      const { noteId } = req.params;
      const { isPinned } = req.body;

      const note = await orderNotesService.setPinned(noteId, isPinned);

      res.json(note);
    } catch (err) {
      next(err);
    }
  }

  async deleteNote(req, res, next) {
    try {
      const userId = req.user?.id || req.user?._id;
      const { noteId } = req.params;

      const note = await orderNotesService.deleteNote(noteId, userId);

      res.json(note);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new OrderNotesController();
