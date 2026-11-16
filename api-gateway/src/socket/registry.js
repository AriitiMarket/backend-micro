// Holds the live Socket.io instance so non-socket modules (the internal
// emit route) can push events without importing app.js.
// Also tracks active socket connections per user to enable presence queries,
// targeted messaging, and memory-safe cleanup on disconnect.
let io = null;

// Map<userId, Set<socketId>>
const userSockets = new Map();
// Map<socketId, userId>
const socketUsers = new Map();

module.exports = {
  setIo(instance) {
    io = instance;
  },
  getIo() {
    return io;
  },

  registerSocket(userId, socketId) {
    if (!userId || !socketId) return;
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId).add(socketId);
    socketUsers.set(socketId, userId);
  },

  unregisterSocket(socketId) {
    if (!socketId) return null;
    const userId = socketUsers.get(socketId);
    if (userId) {
      socketUsers.delete(socketId);
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socketId);
        if (sockets.size === 0) {
          userSockets.delete(userId);
        }
      }
    }
    return userId || null;
  },

  getSocketsForUser(userId) {
    if (!userId || !userSockets.has(userId)) return [];
    return Array.from(userSockets.get(userId));
  },

  getAllActiveUsers() {
    return Array.from(userSockets.keys());
  },

  reset() {
    io = null;
    userSockets.clear();
    socketUsers.clear();
  },
};
