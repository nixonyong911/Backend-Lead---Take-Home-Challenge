import { sequelize } from '../src/db/sequelize';
import { FundingTransaction } from '../src/db/models';
import {
  createMember,
  expectWalletConsistent,
  fundWallet,
  postWager,
  postWithdrawal,
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

describe('POST /withdrawals', () => {
  it('blocks until turnover is met, then debits and creates a Pending withdrawal', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100', 2); // requires 200 turnover

    const blocked = await postWithdrawal(memberId, '50');
    expect(blocked.status).toBe(422);
    expect(blocked.body).toEqual({
      error: 'turnover_not_met',
      requiredTurnover: '200.000000000000000000',
      accruedTurnover: '0.000000000000000000',
      outstandingTurnover: '200.000000000000000000',
    });

    // Win back what we wager by funding again is not modelled; wager part of it and check the breakdown moves.
    expect((await postWager(walletId, '60')).status).toBe(201);
    const stillBlocked = await postWithdrawal(memberId, '10');
    expect(stillBlocked.status).toBe(422);
    expect(stillBlocked.body.outstandingTurnover).toBe('140.000000000000000000');

    await fundWallet(memberId, '150', 0); // adds money, no extra turnover
    expect((await postWager(walletId, '140')).status).toBe(201); // accrued 200 == required 200

    const ok = await postWithdrawal(memberId, '50');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ memberId, status: 'Pending', amount: '50.000000000000000000' });
    expect(ok.body.balance).toBe('0.000000000000000000');
    const withdrawal = await FundingTransaction.findByPk(ok.body.id);
    expect(withdrawal).toMatchObject({ type: 'withdrawal', status: 'Pending' });
    await expectWalletConsistent(walletId);
  });

  it('allows withdrawal when accrued turnover exactly equals required', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100', 1);
    await postWager(walletId, '100');
    await fundWallet(memberId, '30', 0);

    const res = await postWithdrawal(memberId, '30');

    expect(res.status).toBe(201);
    await expectWalletConsistent(walletId);
  });

  it('allows withdrawal right away with multiplier 0', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100', 0);

    const res = await postWithdrawal(memberId, '100');

    expect(res.status).toBe(201);
    expect((await walletState(walletId)).balance).toBe('0.000000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('rejects a withdrawal above the balance and leaves no Pending withdrawal behind', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100', 0);

    const res = await postWithdrawal(memberId, '100.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(await FundingTransaction.count({ where: { memberId, type: 'withdrawal' } })).toBe(0);
    await expectWalletConsistent(walletId);
  });

  it('lets 10 concurrent withdrawals drain the balance but never overdraw it', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100', 0);

    const results = await Promise.all(Array.from({ length: 10 }, () => postWithdrawal(memberId, '30')));

    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(7);
    expect((await walletState(walletId)).balance).toBe('10.000000000000000000');
    expect(await FundingTransaction.count({ where: { memberId, type: 'withdrawal' } })).toBe(3);
    await expectWalletConsistent(walletId);
  });

  it('returns 404 for an unknown member', async () => {
    const res = await postWithdrawal('00000000-0000-4000-8000-000000000000', '1');
    expect(res.status).toBe(404);
  });
});
