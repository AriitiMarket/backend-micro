const mongoose = require('mongoose');

function isValidObjectId(id) {
  if (id === null || id === undefined) return false;
  if (typeof id !== 'string' && typeof id !== 'object') return false;
  return mongoose.Types.ObjectId.isValid(String(id));
}

module.exports = { isValidObjectId };
