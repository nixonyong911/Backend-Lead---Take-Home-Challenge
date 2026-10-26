import request from 'supertest';
import { sequelize } from '../src/db/sequelize';
import { WalletTx } from '../src/db/models';
import {
  app,
  createMember,
  expectWalletConsistent,
  fundWallet,
  newKey,
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

describe('POST /wallets/:walletId/wagers', () => {
  it('debits the wallet and accrues turnover', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100');

    const res = await postWager(walletId, '10.25');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      walletId,
      amount: '10.250000000000000000',
      balance: '89.750000000000000000',
      accruedTurnover: '10.250000000000000000',
    });
    await expectWalletConsistent(walletId);
  });

  it('rejects a wager larger than the balance with 422 and changes nothing', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '10');

    const res = await postWager(walletId, '10.000000000000000001');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(await walletState(walletId)).toMatchObject({
      balance: '10.000000000000000000',
      accrued_turnover: '0.000000000000000000',
    });
    await expectWalletConsistent(walletId);
  });

  it('lets 10 concurrent wagers spend the balance but never overdraw it', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100');

    // 10 x 15 = 150 > 100: exactly 6 fit.
    const results = await Promise.all(Array.from({ length: 10 }, () => postWager(walletId, '15')));

    expect(results.filter((r) => r.status === 201)).toHaveLength(6);
    expect(results.filter((r) => r.status === 422)).toHaveLength(4);
    expect(await walletState(walletId)).toMatchObject({
      balance: '10.000000000000000000',
      accrued_turnover: '90.000000000000000000',
    });
    await expectWalletConsistent(walletId);
  });

  it('places a wager once for 10 concurrent requests with the same Idempotency-Key', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100');
    const key = newKey();

    const results = await Promise.all(Array.from({ length: 10 }, () => postWager(walletId, '10', key)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    // Same response for all (deep equality: JSONB does not keep key order on replay).
    for (const r of results) expect(r.body).toEqual(results[0].body);
    expect(await WalletTx.count({ where: { walletId, type: 'wager' } })).toBe(1);
    expect((await walletState(walletId)).balance).toBe('90.000000000000000000');
    await expectWalletConsistent(walletId);
  });

  it('treats "10" and "10.00" with the same key as the same request', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100');
    const key = newKey();

    expect((await postWager(walletId, '10', key)).status).toBe(201);
    expect((await postWager(walletId, '10.00', key)).status).toBe(201);
    expect((await walletState(walletId)).balance).toBe('90.000000000000000000');
  });

  it('rejects a reused Idempotency-Key with a different amount (422)', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100');
    const key = newKey();

    expect((await postWager(walletId, '10', key)).status).toBe(201);
    const reused = await postWager(walletId, '20', key);

    expect(reused.status).toBe(422);
    expect(reused.body.error).toBe('idempotency_key_reused');
    expect((await walletState(walletId)).balance).toBe('90.000000000000000000');
  });

  it('does not save the key when the wager fails, so a retry after topping up works', async () => {
    const { memberId, walletId } = await createMember();
    const key = newKey();

    expect((await postWager(walletId, '10', key)).status).toBe(422);
    await fundWallet(memberId, '10');
    expect((await postWager(walletId, '10', key)).status).toBe(201);
    await expectWalletConsistent(walletId);
  });

  it('returns 404 for an unknown wallet and 400 for a missing key or bad amount', async () => {
    const { walletId } = await createMember();
    expect((await postWager('00000000-0000-4000-8000-000000000000', '1')).status).toBe(404);
    expect((await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '1' })).status).toBe(400);
    expect((await postWager(walletId, '0')).status).toBe(400);
    expect((await postWager(walletId, '-1')).status).toBe(400);
  });
});
