import { randomUUID } from 'crypto';
import { QueryTypes } from 'sequelize';
import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import '../src/db/models';
import { dec } from '../src/lib/money';

export const app = createApp();

// Expected warnings (unknown pspRef, rejected transitions) would drown the test output.
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

export const newKey = (): string => randomUUID();

let memberSeq = 0;

export async function createMember(): Promise<{ memberId: string; walletId: string }> {
  memberSeq += 1;
  const res = await request(app).post('/members').send({ username: `member${memberSeq}_${Date.now()}` });
  expect(res.status).toBe(201);
  return { memberId: res.body.member.id, walletId: res.body.wallet.id };
}

export function postDeposit(memberId: string, amount: string, turnoverMultiplier = 1, key = newKey()) {
  return request(app).post('/deposits').set('Idempotency-Key', key).send({ memberId, amount, turnoverMultiplier });
}

export function postCallback(body: object) {
  return request(app).post('/psp/callbacks').send(body);
}

export function postWager(walletId: string, amount: string, key = newKey()) {
  return request(app).post(`/wallets/${walletId}/wagers`).set('Idempotency-Key', key).send({ amount });
}

export function postWithdrawal(memberId: string, amount: string, key = newKey()) {
  return request(app).post('/withdrawals').set('Idempotency-Key', key).send({ memberId, amount });
}

// Creates a deposit and completes it through the callback, like the real flow.
export async function fundWallet(memberId: string, amount: string, turnoverMultiplier = 1): Promise<string> {
  const dep = await postDeposit(memberId, amount, turnoverMultiplier);
  expect(dep.status).toBe(201);
  const cb = await postCallback({ pspRef: dep.body.pspRef, status: 'completed', amount });
  expect(cb.status).toBe(200);
  return dep.body.pspRef;
}

export async function walletState(walletId: string) {
  const [row] = await sequelize.query<{ balance: string; required_turnover: string; accrued_turnover: string }>(
    'SELECT balance, required_turnover, accrued_turnover FROM wallets WHERE id = :walletId',
    { replacements: { walletId }, type: QueryTypes.SELECT },
  );
  return row;
}

// The core money invariants. Run after every scenario:
// - SUM(ledger) == wallets.balance
// - required turnover == SUM(amount x multiplier) over Completed deposits
// - accrued turnover == SUM(wager amounts)
// - exactly one ledger credit per Completed deposit, none for others
export async function expectWalletConsistent(walletId: string): Promise<void> {
  const [row] = await sequelize.query<Record<string, string>>(
    `SELECT w.balance, w.required_turnover, w.accrued_turnover,
            COALESCE((SELECT SUM(amount) FROM wallet_txs WHERE wallet_id = w.id), 0) AS ledger_sum,
            COALESCE((SELECT SUM(amount * turnover_multiplier) FROM funding_transactions
                       WHERE wallet_id = w.id AND type = 'deposit' AND status = 'Completed'), 0) AS required_from_history,
            COALESCE((SELECT -SUM(amount) FROM wallet_txs WHERE wallet_id = w.id AND type = 'wager'), 0) AS accrued_from_history,
            (SELECT COUNT(*) FROM wallet_txs WHERE wallet_id = w.id AND type = 'deposit') AS deposit_credits,
            (SELECT COUNT(*) FROM funding_transactions
              WHERE wallet_id = w.id AND type = 'deposit' AND status = 'Completed') AS completed_deposits
       FROM wallets w WHERE w.id = :walletId`,
    { replacements: { walletId }, type: QueryTypes.SELECT },
  );
  expect(dec(row.ledger_sum).isEqualTo(row.balance)).toBe(true);
  expect(dec(row.required_from_history).isEqualTo(row.required_turnover)).toBe(true);
  expect(dec(row.accrued_from_history).isEqualTo(row.accrued_turnover)).toBe(true);
  expect(row.deposit_credits).toBe(row.completed_deposits);
  expect(dec(row.balance).gte(0)).toBe(true);
}

export async function resetDb(): Promise<void> {
  await sequelize.truncate({ cascade: true });
}
