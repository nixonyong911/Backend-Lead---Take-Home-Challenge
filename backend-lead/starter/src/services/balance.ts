import BigNumber from 'bignumber.js';
import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxType } from '../db/models/walletTx';
import { dec, toMoneyString, ZERO } from '../lib/money';
import { InsufficientFunds, InvariantViolation, NotFound } from '../lib/errors';

// The ONLY place that changes wallets.balance / turnover totals. Every change:
//   lock wallet row -> check on the locked values -> DB does the math -> assert -> ledger row.
// All inside the caller's transaction. See DECISIONS.md "Money correctness".

declare const locked: unique symbol;
// A wallet read with SELECT ... FOR UPDATE. Only lockWallet() produces one, so
// applyBalanceChange() cannot be called with an unlocked (possibly stale) wallet.
export type LockedWallet = Wallet & { readonly [locked]: true };

export async function lockWallet(t: Transaction, walletId: string): Promise<LockedWallet> {
  const wallet = await Wallet.findByPk(walletId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!wallet) throw new NotFound('wallet');
  return wallet as LockedWallet;
}

export interface BalanceChange {
  type: WalletTxType;
  amount: BigNumber; // signed: + credit, - debit
  referenceId: string; // deposit/withdrawal funding tx id, or wager id. Unique per type in the ledger.
  requiredTurnoverDelta?: BigNumber;
  accruedTurnoverDelta?: BigNumber;
}

export interface WalletBalances {
  balance: string;
  requiredTurnover: string;
  accruedTurnover: string;
}

interface WalletRow {
  balance: string;
  required_turnover: string;
  accrued_turnover: string;
}

export async function applyBalanceChange(
  t: Transaction,
  wallet: LockedWallet,
  change: BalanceChange,
): Promise<WalletBalances> {
  const requiredDelta = change.requiredTurnoverDelta ?? ZERO;
  const accruedDelta = change.accruedTurnoverDelta ?? ZERO;

  const expectedBalance = dec(wallet.balance).plus(change.amount);
  if (expectedBalance.lt(0)) {
    throw new InsufficientFunds(wallet.balance, toMoneyString(change.amount.abs()));
  }
  const expectedRequired = dec(wallet.requiredTurnover).plus(requiredDelta);
  const expectedAccrued = dec(wallet.accruedTurnover).plus(accruedDelta);

  const rows = await sequelize.query<WalletRow>(
    `UPDATE wallets
        SET balance = balance + :amount::numeric,
            required_turnover = required_turnover + :requiredDelta::numeric,
            accrued_turnover = accrued_turnover + :accruedDelta::numeric,
            updated_at = now()
      WHERE id = :id
      RETURNING balance, required_turnover, accrued_turnover`,
    {
      replacements: {
        id: wallet.id,
        amount: change.amount.toFixed(),
        requiredDelta: requiredDelta.toFixed(),
        accruedDelta: accruedDelta.toFixed(),
      },
      type: QueryTypes.SELECT,
      transaction: t,
    },
  );

  // We hold the row lock, so nothing else can have changed the row. A difference means a bug.
  const row = rows[0];
  if (
    !row ||
    !dec(row.balance).isEqualTo(expectedBalance) ||
    !dec(row.required_turnover).isEqualTo(expectedRequired) ||
    !dec(row.accrued_turnover).isEqualTo(expectedAccrued)
  ) {
    throw new InvariantViolation(
      `wallet ${wallet.id}: expected balance ${expectedBalance.toFixed()}, got ${row?.balance ?? 'no row'}`,
    );
  }

  await WalletTx.create(
    {
      walletId: wallet.id,
      type: change.type,
      amount: toMoneyString(change.amount),
      balanceAfter: row.balance,
      referenceId: change.referenceId,
    },
    { transaction: t },
  );

  return {
    balance: row.balance,
    requiredTurnover: row.required_turnover,
    accruedTurnover: row.accrued_turnover,
  };
}
