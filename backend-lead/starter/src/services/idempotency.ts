import { createHash } from 'crypto';
import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { IdempotencyKeyReused, InvariantViolation } from '../lib/errors';

// Fingerprint of one user action. Callers pass normalized input (e.g. "10.0" -> "10")
// with a fixed key order, so a retry of the same action always hashes the same.
export function hashRequest(operation: string, input: Record<string, string | number>): string {
  return createHash('sha256').update(JSON.stringify({ operation, ...input })).digest('hex');
}

// Runs `action` once per (memberId, key). Must be called inside the transaction that moves the money,
// so the key row and the money change commit (or roll back) together.
//
// Concurrent requests with the same key: the second INSERT waits on the unique index until the
// first transaction commits, then DO NOTHING, and the SELECT sees the saved response.
export async function runIdempotent<T extends object>(
  t: Transaction,
  memberId: string,
  key: string,
  requestHash: string,
  action: () => Promise<T>,
): Promise<T> {
  const inserted = await sequelize.query<{ id: string }>(
    `INSERT INTO idempotency_keys (member_id, key, request_hash)
     VALUES (:memberId, :key, :requestHash)
     ON CONFLICT (member_id, key) DO NOTHING
     RETURNING id`,
    { replacements: { memberId, key, requestHash }, type: QueryTypes.SELECT, transaction: t },
  );

  if (inserted.length === 0) {
    const [existing] = await sequelize.query<{ request_hash: string; response_body: T | null }>(
      'SELECT request_hash, response_body FROM idempotency_keys WHERE member_id = :memberId AND key = :key',
      { replacements: { memberId, key }, type: QueryTypes.SELECT, transaction: t },
    );
    if (!existing) throw new InvariantViolation(`idempotency key ${key}: conflict but no row`);
    if (existing.request_hash !== requestHash) throw new IdempotencyKeyReused();
    if (existing.response_body === null) {
      throw new InvariantViolation(`idempotency key ${key}: committed without a response`);
    }
    return existing.response_body;
  }

  const response = await action();
  await sequelize.query(
    'UPDATE idempotency_keys SET response_body = :body::jsonb, updated_at = now() WHERE id = :id',
    { replacements: { id: inserted[0].id, body: JSON.stringify(response) }, transaction: t },
  );
  return response;
}
