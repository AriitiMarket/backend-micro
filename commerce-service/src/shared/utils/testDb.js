'use strict';
/**
 * The URI of the isolated database a test file runs against.
 *
 * The base URI comes from MONGODB_URI so the tests always run against the
 * deployment's MongoDB instead of a hard-coded localhost: the fulfillment
 * services write inside transactions, so the deployment's Mongo must be a
 * REPLICA SET (a standalone rejects them with "Transaction numbers are only
 * allowed on a replica set member or mongos").
 *
 * Only the DATABASE NAME is swapped, so every test file keeps its own
 * collection namespace while the query string (replicaSet, auth, TLS options)
 * is preserved. The query is what carries the replica-set name, so dropping it
 * would silently turn the deployment's Mongo into a standalone for the tests.
 */

/** Default base URI for a bare-metal run without MONGODB_URI set. */
const DEFAULT_BASE = 'mongodb://localhost:27017';

/**
 * @param {string} databaseName — the isolated database for this test file
 * @param {string} [fallback] — base URI used when MONGODB_URI is not set
 * @returns {string} a MongoDB connection string
 */
function testDbUri(databaseName, fallback = DEFAULT_BASE) {
  const base = process.env.MONGODB_URI || fallback;
  const [withoutQuery, query] = base.split('?');
  const scheme = withoutQuery.startsWith('mongodb+srv://') ? 'mongodb+srv://' : 'mongodb://';
  // Everything before the first '/' after the scheme is the authority
  // (credentials + host + port); the path is the database we replace.
  const authority = withoutQuery.slice(scheme.length).split('/')[0];
  return `${scheme}${authority}/${databaseName}${query ? `?${query}` : ''}`;
}

/**
 * Ensures that if tests run against a standalone MongoDB instance (which rejects
 * multi-document transactions), the session methods degrade gracefully instead of
 * throwing MongoServerError: "Transaction numbers are only allowed on a replica set member".
 * When connected to a real replica set (production or Docker rs0), real transactions run untouched.
 */
function enableStandaloneSessionFallback(mongoose) {
  if (!mongoose || mongoose.__standaloneSessionShimInstalled) return;
  mongoose.__standaloneSessionShimInstalled = true;

  const origStartSession = mongoose.startSession.bind(mongoose);
  mongoose.startSession = async function (...args) {
    const session = await origStartSession(...args);
    const setName = mongoose.connection.client?.topology?.description?.setName;
    const isReplica = Boolean(
      setName ||
      mongoose.connection.client?.topology?.description?.type === 'ReplicaSetWithPrimary'
    );
    if (!isReplica) {
      session.startTransaction = () => {};
      session.commitTransaction = async () => {};
      session.abortTransaction = async () => {};
      session.inTransaction = () => false;
      session.withTransaction = async (fn) => fn(session);
    }
    return session;
  };
}

module.exports = { testDbUri, DEFAULT_BASE, enableStandaloneSessionFallback };
