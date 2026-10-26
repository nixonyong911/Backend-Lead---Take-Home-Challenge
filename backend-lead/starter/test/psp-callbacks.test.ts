import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/db/sequelize';
import { PspCallback } from '../src/db/models';
import {
  createMember,
  expectWalletConsistent,
  postCallback,
  postDeposit,
  postWager,
  resetDb,
  walletState,
} from './helpers';

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(resetDb);

afterAll(async () => {
  await sequelize.close();
});

async function pendingDeposit(amount = '100.50', multiplier = 1) {
  const { memberId, walletId } = await createMember();
  const dep = await postDeposit(memberId, amount, multiplier);
  expect(dep.status).toBe(201);
  return { memberId, walletId, pspRef: dep.body.pspRef as string, depositId: dep.body.id as string };
}

describe('POST /psp/callbacks', () => {
  it('credits a completed deposit once and adds the turnover requirement', async () => {
    const { walletId, pspRef } = await pendingDeposit('100.50', 2);

    const res = await postCallback({ pspRef, status: 'completed', amount: '100.50' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('credited');
    expect(res.body.fundingTransaction.status).toBe('Completed');
    const w = await walletState(walletId);
    expect(w.balance).toBe('100.500000000000000000');
    expect(w.required_turnover).toBe('201.000000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('does not double-credit on sequential duplicate callbacks', async () => {
    const { walletId, pspRef } = await pendingDeposit();

    const first = await postCallback({ pspRef, status: 'completed', amount: '100.50' });
    const second = await postCallback({ pspRef, status: 'completed', amount: '100.50' });
    const third = await postCallback({ pspRef, status: 'completed', amount: '100.50' });

    expect(first.status).toBe(200);
    for (const dup of [second, third]) {
      expect(dup.status).toBe(202);
      expect(dup.body.outcome).toBe('duplicate');
      expect(dup.body.fundingTransaction.status).toBe('Completed');
    }
    expect((await walletState(walletId)).balance).toBe('100.500000000000000000');
    expect(await PspCallback.count({ where: { pspRef } })).toBe(3);
    await expectWalletConsistent(walletId);
  });

  it('does not double-credit on 10 concurrent duplicate callbacks', async () => {
    const { walletId, pspRef } = await pendingDeposit();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => postCallback({ pspRef, status: 'completed', amount: '100.50' })),
    );

    const outcomes = results.map((r) => r.body.outcome);
    expect(outcomes.filter((o) => o === 'credited')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(9);
    expect(results.every((r) => r.status === 200 || r.status === 202)).toBe(true);
    expect((await walletState(walletId)).balance).toBe('100.500000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('ignores a completed callback replayed late, after the money was spent', async () => {
    const { walletId, pspRef } = await pendingDeposit('100');
    await postCallback({ pspRef, status: 'completed', amount: '100' });
    expect((await postWager(walletId, '60')).status).toBe(201);

    const late = await postCallback({ pspRef, status: 'completed', amount: '100' });

    expect(late.status).toBe(202);
    expect(late.body.outcome).toBe('duplicate');
    expect((await walletState(walletId)).balance).toBe('40.000000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('rejects failed after Completed: nothing applied, balance unchanged', async () => {
    const { walletId, pspRef } = await pendingDeposit();
    await postCallback({ pspRef, status: 'completed', amount: '100.50' });

    const res = await postCallback({ pspRef, status: 'failed', amount: '100.50' });

    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe('invalid_transition');
    expect(res.body.fundingTransaction.status).toBe('Completed');
    expect((await walletState(walletId)).balance).toBe('100.500000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('marks a failed deposit Failed without moving money, then rejects completed after Failed', async () => {
    const { walletId, pspRef } = await pendingDeposit();

    const failed = await postCallback({ pspRef, status: 'failed', amount: '100.50' });
    expect(failed.status).toBe(200);
    expect(failed.body.outcome).toBe('failed');
    expect(failed.body.fundingTransaction).toMatchObject({ status: 'Failed', failureReason: 'psp_failed' });

    const completed = await postCallback({ pspRef, status: 'completed', amount: '100.50' });
    expect(completed.status).toBe(202);
    expect(completed.body.outcome).toBe('invalid_transition');
    expect((await walletState(walletId)).balance).toBe('0.000000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('treats "100.5" and "100.50" as the same amount', async () => {
    const { walletId, pspRef } = await pendingDeposit('100.50');

    const res = await postCallback({ pspRef, status: 'completed', amount: '100.5' });

    expect(res.body.outcome).toBe('credited');
    expect((await walletState(walletId)).balance).toBe('100.500000000000000000');
  });

  it('never credits on amount mismatch: fails the deposit and flags it for review', async () => {
    const { walletId, pspRef } = await pendingDeposit('100.50');

    const res = await postCallback({ pspRef, status: 'completed', amount: '100.49' });

    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe('amount_mismatch');
    expect(res.body.fundingTransaction).toMatchObject({ status: 'Failed', failureReason: 'amount_mismatch' });

    // A later callback with the right amount cannot revive it.
    const retry = await postCallback({ pspRef, status: 'completed', amount: '100.50' });
    expect(retry.status).toBe(202);
    expect(retry.body.outcome).toBe('invalid_transition');
    expect((await walletState(walletId)).balance).toBe('0.000000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('answers 202 for an unknown pspRef and stores the payload', async () => {
    const res = await postCallback({ pspRef: 'psp_does_not_exist', status: 'completed', amount: '10' });

    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe('unknown_ref');
    const stored = await PspCallback.findOne({ where: { pspRef: 'psp_does_not_exist' } });
    expect(stored?.outcome).toBe('unknown_ref');
    expect(stored?.payload).toEqual({ pspRef: 'psp_does_not_exist', status: 'completed', amount: '10' });
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['exponent', '1e2'],
    ['too many decimals', '1.0000000000000000001'],
    ['a JS number', 100.5],
  ])('rejects a %s amount with 400 and keeps the payload', async (_label, amount) => {
    const { walletId, pspRef } = await pendingDeposit();

    const res = await postCallback({ pspRef, status: 'completed', amount });

    expect(res.status).toBe(400);
    expect((await PspCallback.findOne({ where: { pspRef } }))?.outcome).toBe('invalid_payload');
    expect((await walletState(walletId)).balance).toBe('0.000000000000000000');
  });

  it('rejects an unknown status with 400', async () => {
    const { pspRef } = await pendingDeposit();
    const res = await postCallback({ pspRef, status: 'success', amount: '100.50' });
    expect(res.status).toBe(400);
  });
});

describe('append-only tables', () => {
  it('refuses UPDATE and DELETE on wallet_txs and psp_callbacks', async () => {
    const { walletId, pspRef } = await pendingDeposit();
    await postCallback({ pspRef, status: 'completed', amount: '100.50' });

    await expect(sequelize.query('UPDATE wallet_txs SET amount = 1', { type: QueryTypes.UPDATE })).rejects.toThrow(
      /append-only/,
    );
    await expect(sequelize.query('DELETE FROM wallet_txs', { type: QueryTypes.DELETE })).rejects.toThrow(/append-only/);
    await expect(sequelize.query('DELETE FROM psp_callbacks', { type: QueryTypes.DELETE })).rejects.toThrow(
      /append-only/,
    );
    await expectWalletConsistent(walletId);
  });

  it('refuses a second ledger credit for the same deposit at the DB level', async () => {
    const { walletId, pspRef, depositId } = await pendingDeposit();
    await postCallback({ pspRef, status: 'completed', amount: '100.50' });

    await expect(
      sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, reference_id)
         VALUES (:walletId, 'deposit', 100.5, 201, :depositId)`,
        { replacements: { walletId, depositId }, type: QueryTypes.INSERT },
      ),
    ).rejects.toThrow();
  });
});
