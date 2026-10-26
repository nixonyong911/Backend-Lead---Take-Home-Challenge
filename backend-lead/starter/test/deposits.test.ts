import request from 'supertest';
import { sequelize } from '../src/db/sequelize';
import { FundingTransaction } from '../src/db/models';
import { app, createMember, newKey, postCallback, postDeposit, resetDb, walletState } from './helpers';

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(resetDb);

afterAll(async () => {
  await sequelize.close();
});

describe('POST /deposits', () => {
  it('creates a Pending deposit with a pspRef and moves no money', async () => {
    const { memberId, walletId } = await createMember();

    const res = await postDeposit(memberId, '100.50', 3);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      memberId,
      status: 'Pending',
      amount: '100.500000000000000000',
      turnoverMultiplier: 3,
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.pspRef).toMatch(/^psp_[0-9a-f]{32}$/);
    expect((await walletState(walletId)).balance).toBe('0.000000000000000000');
  });

  it('defaults turnoverMultiplier to 1', async () => {
    const { memberId } = await createMember();
    const res = await request(app)
      .post('/deposits')
      .set('Idempotency-Key', newKey())
      .send({ memberId, amount: '10' });
    expect(res.status).toBe(201);
    expect(res.body.turnoverMultiplier).toBe(1);
  });

  it.each([
    ['zero amount', { amount: '0' }],
    ['negative amount', { amount: '-5' }],
    ['numeric amount', { amount: 10 }],
    ['exponent amount', { amount: '1e3' }],
    ['19 decimals', { amount: '1.0000000000000000001' }],
    ['negative multiplier', { amount: '10', turnoverMultiplier: -1 }],
    ['fractional multiplier', { amount: '10', turnoverMultiplier: 1.5 }],
  ])('rejects %s with 400', async (_label, body) => {
    const { memberId } = await createMember();
    const res = await request(app)
      .post('/deposits')
      .set('Idempotency-Key', newKey())
      .send({ memberId, ...body });
    expect(res.status).toBe(400);
  });

  it('requires an Idempotency-Key header', async () => {
    const { memberId } = await createMember();
    const res = await request(app).post('/deposits').send({ memberId, amount: '10' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown member', async () => {
    const res = await postDeposit('00000000-0000-4000-8000-000000000000', '10');
    expect(res.status).toBe(404);
  });

  it('allows only one Pending deposit per member (409), and a new one once it is final', async () => {
    const { memberId } = await createMember();
    const first = await postDeposit(memberId, '10');
    expect((await postDeposit(memberId, '20')).status).toBe(409);

    await postCallback({ pspRef: first.body.pspRef, status: 'completed', amount: '10' });
    expect((await postDeposit(memberId, '20')).status).toBe(201);
  });

  it('lets only one of 10 concurrent deposits (different keys) through', async () => {
    const { memberId } = await createMember();

    const results = await Promise.all(Array.from({ length: 10 }, () => postDeposit(memberId, '10')));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await FundingTransaction.count({ where: { memberId } })).toBe(1);
  });

  it('replays the same deposit for a retried Idempotency-Key', async () => {
    const { memberId } = await createMember();
    const key = newKey();

    const results = await Promise.all(Array.from({ length: 5 }, () => postDeposit(memberId, '10', 1, key)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.pspRef)).size).toBe(1);
    expect(await FundingTransaction.count({ where: { memberId } })).toBe(1);
  });
});
