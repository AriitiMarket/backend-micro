'use strict';

const mongoose = require('mongoose');

/**
 * Checks whether the current MongoDB connection belongs to a Replica Set or Mongos.
 * Standalone MongoDB instances do not support multi-document transactions.
 */
function isReplicaSet(connection = mongoose.connection) {
  const desc = connection.client?.topology?.description;
  if (!desc) return false;
  return Boolean(
    desc.setName ||
    desc.type === 'ReplicaSetWithPrimary' ||
    desc.type === 'Sharded'
  );
}

/**
 * Executes a function within a Mongoose transaction session.
 * If running on a Replica Set, runs with full ACID transaction guarantees.
 * If running against a standalone MongoDB (such as local dev / test), falls back
 * safely to executing with the session without starting a replica set transaction.
 *
 * @param {Function} workFn - async function(session) => result
 * @param {Object} [options]
 * @param {ClientSession} [options.session] - Existing parent session to participate in
 * @returns {Promise<any>}
 */
async function runInTransaction(workFn, options = {}) {
  if (options.session) {
    // Already inside an active session/transaction
    return workFn(options.session);
  }

  const session = await mongoose.startSession();
  const canTransact = isReplicaSet();

  try {
    if (canTransact) {
      let result;
      await session.withTransaction(async () => {
        result = await workFn(session);
      });
      return result;
    } else {
      return await workFn(session);
    }
  } finally {
    await session.endSession();
  }
}

module.exports = {
  isReplicaSet,
  runInTransaction,
};
