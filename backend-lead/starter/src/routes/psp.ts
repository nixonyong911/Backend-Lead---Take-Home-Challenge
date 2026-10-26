import { Router } from 'express';
import { z } from 'zod';
import { positiveMoney } from '../lib/money';
import * as pspCallbackService from '../services/pspCallbackService';

export const pspRouter = Router();

const callbackBody = z.object({
  pspRef: z.string().min(1).max(255),
  status: z.enum(['completed', 'failed']),
  amount: positiveMoney,
});

pspRouter.post('/callbacks', async (req, res, next) => {
  try {
    const parsed = callbackBody.safeParse(req.body);
    if (!parsed.success) {
      await pspCallbackService.recordInvalidCallback(req.body);
      throw parsed.error;
    }
    const result = await pspCallbackService.handleCallback(parsed.data, req.body);
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    next(err);
  }
});
