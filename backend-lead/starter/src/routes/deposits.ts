import { Router } from 'express';
import { z } from 'zod';
import { positiveMoney } from '../lib/money';
import * as depositService from '../services/depositService';
import { idempotencyKey } from './idempotencyKey';

export const depositsRouter = Router();

const createDepositBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoney,
  // Upper bound is a sanity limit (assumption); keeps amount x multiplier inside DECIMAL(36,18).
  turnoverMultiplier: z.number().int().min(0).max(100).default(1),
});

depositsRouter.post('/', async (req, res, next) => {
  try {
    const key = idempotencyKey(req);
    const body = createDepositBody.parse(req.body);
    const deposit = await depositService.createDeposit(body, key);
    res.status(201).json(deposit);
  } catch (err) {
    next(err);
  }
});
