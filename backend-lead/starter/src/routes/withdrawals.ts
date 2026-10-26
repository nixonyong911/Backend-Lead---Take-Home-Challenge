import { Router } from 'express';
import { z } from 'zod';
import { positiveMoney } from '../lib/money';
import * as withdrawalService from '../services/withdrawalService';
import { idempotencyKey } from './idempotencyKey';

export const withdrawalsRouter = Router();

const withdrawalBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoney,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const key = idempotencyKey(req);
    const body = withdrawalBody.parse(req.body);
    const withdrawal = await withdrawalService.requestWithdrawal(body.memberId, body.amount, key);
    res.status(201).json(withdrawal);
  } catch (err) {
    next(err);
  }
});
