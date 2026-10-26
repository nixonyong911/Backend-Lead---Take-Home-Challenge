import { randomUUID } from 'crypto';
import { sequelize } from '../db/sequelize';
import { Wallet } from '../db/models';
import { dec, toMoneyString } from '../lib/money';
import { NotFound } from '../lib/errors';
import { applyBalanceChange, lockWallet } from './balance';
import { hashRequest, runIdempotent } from './idempotency';

export interface WagerResponse {
  wagerId: string;
  walletId: string;
  amount: string;
  balance: string;
  accruedTurnover: string;
}

// Debits the wallet and accrues turnover = amount, in one transaction under the wallet lock.
export async function placeWager(walletId: string, amountInput: string, idempotencyKey: string): Promise<WagerResponse> {
  // Unlocked read only to find the owner for the idempotency scope; member_id never changes.
  const wallet = await Wallet.findByPk(walletId);
  if (!wallet) throw new NotFound('wallet');

  const amount = dec(amountInput);
  const requestHash = hashRequest('wager', { walletId, amount: amount.toFixed() });

  return sequelize.transaction((t) =>
    runIdempotent(t, wallet.memberId, idempotencyKey, requestHash, async () => {
      const locked = await lockWallet(t, walletId);
      const wagerId = randomUUID();
      const balances = await applyBalanceChange(t, locked, {
        type: 'wager',
        amount: amount.negated(),
        referenceId: wagerId,
        accruedTurnoverDelta: amount,
      });
      return {
        wagerId,
        walletId,
        amount: toMoneyString(amount),
        balance: balances.balance,
        accruedTurnover: balances.accruedTurnover,
      };
    }),
  );
}
