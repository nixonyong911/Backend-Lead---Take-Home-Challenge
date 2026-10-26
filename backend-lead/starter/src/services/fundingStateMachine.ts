import { Transaction } from 'sequelize';
import { FundingTransaction } from '../db/models';
import { FundingStatus } from '../db/models/fundingTransaction';
import { InvalidTransition, InvariantViolation } from '../lib/errors';

// Pending -> Completed | Failed. Completed and Failed are final.
const ALLOWED: Record<FundingStatus, readonly FundingStatus[]> = {
  Pending: ['Completed', 'Failed'],
  Completed: [],
  Failed: [],
};

export function canTransition(from: FundingStatus, to: FundingStatus): boolean {
  return ALLOWED[from].includes(to);
}

// Caller must hold the row lock on `ftx`. The WHERE status guard is a second check:
// if the row is not in the status we read, nothing changes and we fail loudly.
export async function transition(
  t: Transaction,
  ftx: FundingTransaction,
  to: FundingStatus,
  failureReason: string | null = null,
): Promise<void> {
  if (!canTransition(ftx.status, to)) throw new InvalidTransition(ftx.status, to);

  const [changed] = await FundingTransaction.update(
    { status: to, failureReason },
    { where: { id: ftx.id, status: ftx.status }, transaction: t },
  );
  if (changed !== 1) {
    throw new InvariantViolation(`funding tx ${ftx.id}: guarded ${ftx.status} -> ${to} changed ${changed} rows`);
  }
  ftx.status = to;
  ftx.failureReason = failureReason;
}
