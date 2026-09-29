// Agent entity model — maps a PostgreSQL agents row to a clean camelCase object.
const AGENT_FIELDS = Object.freeze([
  'id',
  'userId',
  'sectorId',
  'commissionRate',
  'isActive',
  'verificationStatus',
  'documents',
  'rating',
  'totalTransactions',
  'createdAt',
  'updatedAt',
]);

function toAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    sectorId: row.sector_id || null,
    commissionRate: parseFloat(row.commission_rate) || 0,
    isActive: row.is_active,
    verificationStatus: row.verification_status,
    documents: row.documents || [],
    rating: parseFloat(row.rating) || 0,
    totalTransactions: row.total_transactions || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { AGENT_FIELDS, toAgent };