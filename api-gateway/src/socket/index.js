// Real-time messaging gateway (Socket.io) co-located with the API Gateway so
// the frontend talks to a single origin (http://localhost:8000). Mirrors the
// original E-Shop socket event contract.
//
// Security: no cookies are used. Every socket must present a valid RS256 access
// token in the handshake (auth.token) — anonymous connections are rejected.
const { Server } = require('socket.io');
const { verifyToken } = require('../utils/jwks');
const registry = require('./registry');

const REQUEST_ID_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/;
const MAX_SUBSCRIBED_REQUESTS = 50;

module.exports = function attachSocket(server, corsOrigins) {
  const allowWildcard = !corsOrigins
    || corsOrigins === '*'
    || (Array.isArray(corsOrigins) && (corsOrigins.includes('*') || corsOrigins.length === 0));

  const io = new Server(server, {
    cors: {
      origin: allowWildcard
        ? (origin, callback) => callback(null, true)
        : (origin, callback) => {
            if (!origin) return callback(null, true);
            const origins = Array.isArray(corsOrigins) ? corsOrigins : [corsOrigins];
            if (origins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
              return callback(null, true);
            }
            return callback(null, false);
          },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
  registry.setIo(io);

  // Authenticate the handshake with the same JWT used for REST calls.
  io.use(async (socket, next) => {
    const raw = (socket.handshake.auth && socket.handshake.auth.token)
      || (socket.handshake.headers && socket.handshake.headers.authorization) || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = await verifyToken(token);
      socket.data.userId = payload.sub || payload.userId || null;
      socket.data.role = payload.role || null;
      socket.data.roles = Array.isArray(payload.roles)
        ? payload.roles
        : (payload.role ? [payload.role] : []);
      socket.data.shopId = payload.shopId || null;
      socket.data.providerId = payload.providerId || null;

      if (!socket.data.userId) return next(new Error('unauthorized'));
      return next();
    } catch (err) {
      return next(new Error('unauthorized'));
    }
  });

  let users = [];
  const addUser = (userId, socketId) => {
    if (!users.some((u) => u.userId === userId)) users.push({ userId, socketId });
  };
  const removeUser = (socketId) => {
    users = users.filter((u) => u.socketId !== socketId);
  };
  const getUser = (receiverId) => users.find((u) => u.userId === receiverId);

  let messageSeq = 0;
  const createMessage = ({ senderId, receiverId, text, images }) => ({
    id: 'msg_' + (++messageSeq) + '_' + Date.now(),
    senderId,
    receiverId,
    text,
    images: images || [],
    seen: false,
    createdAt: new Date().toISOString(),
  });

  io.on('connection', (socket) => {
    // Sender identity always comes from the verified token, never the client.
    const authenticatedUserId = socket.data.userId;
    registry.registerSocket(authenticatedUserId, socket.id);
    console.log('[gateway-socket] user connected:', authenticatedUserId);

    // Every socket sits in its own user-room, so request events addressed to
    // this user always reach them — the client never picks a room itself.
    const userRoom = `user:${authenticatedUserId}`;
    socket.join(userRoom);

    // Auto-join permitted shop or provider rooms if associated in verified token
    if (socket.data.shopId) {
      socket.join(`shop:${socket.data.shopId}`);
    }
    if (socket.data.providerId) {
      socket.join(`provider:${socket.data.providerId}`);
    }

    /**
     * Opt-in per-request rooms: a workspace page tells the gateway which
     * request ids it is looking at, and nothing else is delivered there.
     */
    socket.on('request:subscribe', (payload = {}) => {
      const ids = (Array.isArray(payload && payload.requestIds) ? payload.requestIds : [])
        .filter((value) => typeof value === 'string' && REQUEST_ID_PATTERN.test(value))
        .slice(0, MAX_SUBSCRIBED_REQUESTS);
      ids.forEach((id) => socket.join(`request:${id}`));
      socket.emit('request:subscribed', { requestIds: ids });
    });

    socket.on('request:unsubscribe', (payload = {}) => {
      const ids = (Array.isArray(payload && payload.requestIds) ? payload.requestIds : [])
        .filter((value) => typeof value === 'string' && REQUEST_ID_PATTERN.test(value))
        .slice(0, MAX_SUBSCRIBED_REQUESTS);
      ids.forEach((id) => socket.leave(`request:${id}`));
    });

    // Enforce authorization checks on shop room subscription
    socket.on('shop:subscribe', (payload = {}) => {
      const shopId = payload && payload.shopId;
      const isAdmin = socket.data.roles?.includes('admin') || socket.data.role === 'admin';
      if (!shopId || (socket.data.shopId !== shopId && !isAdmin)) {
        return socket.emit('error', { message: 'Unauthorized room subscription' });
      }
      socket.join(`shop:${shopId}`);
      socket.emit('shop:subscribed', { shopId });
    });

    // Enforce authorization checks on provider room subscription
    socket.on('provider:subscribe', (payload = {}) => {
      const providerId = payload && payload.providerId;
      const isAdmin = socket.data.roles?.includes('admin') || socket.data.role === 'admin';
      if (!providerId || (socket.data.providerId !== providerId && !isAdmin)) {
        return socket.emit('error', { message: 'Unauthorized room subscription' });
      }
      socket.join(`provider:${providerId}`);
      socket.emit('provider:subscribed', { providerId });
    });

    socket.on('addUser', () => {
      addUser(authenticatedUserId, socket.id);
      io.emit('getUsers', users);
    });

    socket.on('sendMessage', ({ receiverId, text, images }) => {
      if (!receiverId) return;
      const message = createMessage({
        senderId: authenticatedUserId,
        receiverId,
        text,
        images,
      });
      const user = getUser(receiverId);
      if (user) io.to(user.socketId).emit('getMessage', message);
    });

    socket.on('messageSeen', ({ senderId, receiverId, messageId }) => {
      const user = getUser(senderId);
      if (user) io.to(user.socketId).emit('messageSeen', { senderId, receiverId, messageId });
    });

    socket.on('updateLastMessage', ({ lastMessage, lastMessageId }) => {
      io.emit('getLastMessage', { lastMessage, lastMessageId });
    });

    socket.on('disconnect', () => {
      registry.unregisterSocket(socket.id);
      removeUser(socket.id);
      io.emit('getUsers', users);
    });
  });

  return io;
};
