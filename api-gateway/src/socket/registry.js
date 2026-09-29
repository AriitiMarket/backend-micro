// Holds the live Socket.io instance so non-socket modules (the internal
// emit route) can push events without importing app.js.
let io = null;

module.exports = {
  setIo(instance) {
    io = instance;
  },
  getIo() {
    return io;
  },
};
