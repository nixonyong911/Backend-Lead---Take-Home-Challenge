import { Router } from 'express';
import { z } from 'zod';
import { positiveMoney } from '../lib/money';
import * as wagerService from '../services/wagerService';
import { idempotencyKey } from './idempotencyKey';

export const walletsRouter = Router();

const walletParams = z.object({ walletId: z.string().uuid() });
const wagerBody = z.object({ amount: positiveMoney });

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const key = idempotencyKey(req);
    const { walletId } = walletParams.parse(req.params);
    const body = wagerBody.parse(req.body);
    const wager = await wagerService.placeWager(walletId, body.amount, key);
    res.status(201).json(wager);
  } catch (err) {
    next(err);
  }
});
