import { randomBytes } from 'crypto';
import { UniqueConstraintError } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { FundingTransaction, Member, Wallet } from '../db/models';
import { dec, toMoneyString } from '../lib/money';
import { NotFound, PendingDepositExists } from '../lib/errors';
import { hashRequest, runIdempotent } from './idempotency';

export interface CreateDepositInput {
  memberId: string;
  amount: string;
  turnoverMultiplier: number;
}

export interface DepositResponse {
  id: string;
  memberId: string;
  pspRef: string;
  status: string;
  amount: string;
  turnoverMultiplier: number;
}

const ONE_PENDING_DEPOSIT_INDEX = 'funding_transactions_one_pending_deposit';

// Creates a Pending deposit. No money moves until the PSP callback completes it.
export async function createDeposit(input: CreateDepositInput, idempotencyKey: string): Promise<DepositResponse> {
  const member = await Member.findByPk(input.memberId);
  if (!member) throw new NotFound('member');
  const wallet = await Wallet.findOne({ where: { memberId: member.id } });
  if (!wallet) throw new NotFound('wallet');

  const amount = dec(input.amount);
  const requestHash = hashRequest('deposit', {
    memberId: member.id,
    amount: input.amount,
    turnoverMultiplier: input.turnoverMultiplier,
  });

  return sequelize.transaction((t) =>
    runIdempotent(t, member.id, idempotencyKey, requestHash, async () => {
      let deposit: FundingTransaction;
      try {
        deposit = await FundingTransaction.create(
          {
            memberId: member.id,
            walletId: wallet.id,
            type: 'deposit',
            status: 'Pending',
            amount: toMoneyString(amount),
            pspRef: `psp_${randomBytes(16).toString('hex')}`,
            turnoverMultiplier: input.turnoverMultiplier,
          },
          { transaction: t },
        );
      } catch (err) {
        if (err instanceof UniqueConstraintError && pgConstraint(err) === ONE_PENDING_DEPOSIT_INDEX) {
          throw new PendingDepositExists();
        }
        throw err;
      }
      return {
        id: deposit.id,
        memberId: deposit.memberId,
        pspRef: deposit.pspRef as string,
        status: deposit.status,
        amount: deposit.amount,
        turnoverMultiplier: input.turnoverMultiplier,
      };
    }),
  );
}

function pgConstraint(err: UniqueConstraintError): string | undefined {
  return (err.parent as { constraint?: string } | undefined)?.constraint;
}
