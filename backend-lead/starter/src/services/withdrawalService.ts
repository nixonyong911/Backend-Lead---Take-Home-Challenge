import { sequelize } from '../db/sequelize';
import { FundingTransaction, Wallet } from '../db/models';
import { dec, toMoneyString } from '../lib/money';
import { NotFound, TurnoverNotMet } from '../lib/errors';
import { applyBalanceChange, lockWallet } from './balance';
import { hashRequest, runIdempotent } from './idempotency';

export interface WithdrawalResponse {
  id: string;
  memberId: string;
  status: string;
  amount: string;
  balance: string;
}

// Turnover check and debit happen on the locked wallet row, so a concurrent wager or
// withdrawal cannot slip in between the check and the write.
export async function requestWithdrawal(
  memberId: string,
  amountInput: string,
  idempotencyKey: string,
): Promise<WithdrawalResponse> {
  const wallet = await Wallet.findOne({ where: { memberId } });
  if (!wallet) throw new NotFound('member');

  const amount = dec(amountInput);
  const requestHash = hashRequest('withdrawal', { memberId, amount: amountInput });

  return sequelize.transaction((t) =>
    runIdempotent(t, memberId, idempotencyKey, requestHash, async () => {
      const locked = await lockWallet(t, wallet.id);

      const required = dec(locked.requiredTurnover);
      const accrued = dec(locked.accruedTurnover);
      if (accrued.lt(required)) {
        throw new TurnoverNotMet(
          toMoneyString(required),
          toMoneyString(accrued),
          toMoneyString(required.minus(accrued)),
        );
      }

      // Approval is out of scope: the withdrawal stays Pending, but the money leaves the wallet now.
      const withdrawal = await FundingTransaction.create(
        {
          memberId,
          walletId: wallet.id,
          type: 'withdrawal',
          status: 'Pending',
          amount: toMoneyString(amount),
        },
        { transaction: t },
      );
      // Throws InsufficientFunds if the balance is too low; the whole transaction (incl. the row above) rolls back.
      const balances = await applyBalanceChange(t, locked, {
        type: 'withdrawal',
        amount: amount.negated(),
        referenceId: withdrawal.id,
      });

      return {
        id: withdrawal.id,
        memberId,
        status: withdrawal.status,
        amount: withdrawal.amount,
        balance: balances.balance,
      };
    }),
  );
}
