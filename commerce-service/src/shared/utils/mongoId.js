// Shared Mongo id guard.
//
// Admin APIs receive ids from the UI (and from other services) that are not
// guaranteed to be ObjectIds — e.g. a legacy string id or a typo. Passing those
// into Mongoose would throw a CastError and surface as a 500, so every
// repository entry point normalises the id first and lets the caller turn a
// miss into a clean 404.
const mongoose = require('mongoose');

function isValidObjectId(id) {
  if (id === null || id === undefined) return false;
  if (typeof id !== 'string' && typeof id !== 'object') return false;
  return mongoose.Types.ObjectId.isValid(String(id));
}

module.exports = { isValidObjectId };