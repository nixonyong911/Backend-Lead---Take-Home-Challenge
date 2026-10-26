import { sequelize } from '../db/sequelize';
import { FundingTransaction, PspCallback } from '../db/models';
import { FundingStatus } from '../db/models/fundingTransaction';
import { CallbackOutcome } from '../db/models/pspCallback';
import { dec } from '../lib/money';
import { applyBalanceChange, lockWallet } from './balance';
import { canTransition, transition } from './fundingStateMachine';

export interface CallbackInput {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
}

export interface CallbackResult {
  httpStatus: 200 | 202;
  body: {
    outcome: CallbackOutcome;
    fundingTransaction?: { id: string; status: FundingStatus; failureReason: string | null };
  };
}

const TARGET_STATUS: Record<CallbackInput['status'], FundingStatus> = {
  completed: 'Completed',
  failed: 'Failed',
};

// 200 = we applied something. 202 = accepted but nothing applied (duplicate, unknown ref,
// mismatch, invalid transition). Never 4xx/5xx for these: the PSP would retry forever.
const APPLIED: readonly CallbackOutcome[] = ['credited', 'failed'];

// `raw` is the request body exactly as received; it goes to the audit table untouched.
export async function handleCallback(input: CallbackInput, raw: unknown): Promise<CallbackResult> {
  return sequelize.transaction(async (t) => {
    // Lock order: funding tx first, then wallet (inside applyBalanceChange's caller). Same order everywhere.
    // Concurrent duplicates queue here; each one re-reads the status after the previous one committed.
    const deposit = await FundingTransaction.findOne({
      where: { pspRef: input.pspRef, type: 'deposit' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!deposit) {
      await PspCallback.create({ pspRef: input.pspRef, payload: raw, outcome: 'unknown_ref' }, { transaction: t });
      // eslint-disable-next-line no-console
      console.warn(`[psp] callback for unknown pspRef ${input.pspRef}`);
      return { httpStatus: 202, body: { outcome: 'unknown_ref' } };
    }

    const target = TARGET_STATUS[input.status];
    let outcome: CallbackOutcome;

    if (deposit.status === target) {
      outcome = 'duplicate';
    } else if (!canTransition(deposit.status, target)) {
      outcome = 'invalid_transition';
      // eslint-disable-next-line no-console
      console.warn(`[psp] rejected ${deposit.status} -> ${target} for deposit ${deposit.id}`);
    } else if (target === 'Failed') {
      await transition(t, deposit, 'Failed', 'psp_failed');
      outcome = 'failed';
    } else if (!dec(input.amount).isEqualTo(deposit.amount)) {
      // Never credit an amount we did not agree to. Fail it and leave it for ops review.
      await transition(t, deposit, 'Failed', 'amount_mismatch');
      outcome = 'amount_mismatch';
    } else {
      await transition(t, deposit, 'Completed');
      const wallet = await lockWallet(t, deposit.walletId);
      const amount = dec(deposit.amount); // the deposit's amount, never the callback's
      await applyBalanceChange(t, wallet, {
        type: 'deposit',
        amount,
        referenceId: deposit.id,
        requiredTurnoverDelta: amount.times(deposit.turnoverMultiplier ?? 0),
      });
      outcome = 'credited';
    }

    await PspCallback.create(
      { pspRef: input.pspRef, fundingTransactionId: deposit.id, payload: raw, outcome },
      { transaction: t },
    );

    return {
      httpStatus: APPLIED.includes(outcome) ? 200 : 202,
      body: {
        outcome,
        fundingTransaction: { id: deposit.id, status: deposit.status, failureReason: deposit.failureReason },
      },
    };
  });
}

// Payload failed validation. Keep it for audit; the route still answers 400.
export async function recordInvalidCallback(raw: unknown): Promise<void> {
  const pspRef = typeof (raw as { pspRef?: unknown })?.pspRef === 'string' ? (raw as { pspRef: string }).pspRef : null;
  await PspCallback.create({ pspRef, payload: raw ?? {}, outcome: 'invalid_payload' });
}
