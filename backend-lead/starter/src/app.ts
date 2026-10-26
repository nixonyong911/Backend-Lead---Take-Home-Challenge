import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { DomainError, InvariantViolation } from './lib/errors';
import { healthRouter } from './routes/health';
import { membersRouter } from './routes/members';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', details: err.issues });
    return;
  }
  if (err instanceof DomainError) {
    res.status(err.status).json({ error: err.code, ...err.details });
    return;
  }
  if (err instanceof InvariantViolation) {
    // A money invariant broke: the transaction was rolled back. In production this pages on-call.
    // eslint-disable-next-line no-console
    console.error('[ALERT] money invariant violated:', err.message);
  } else {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(500).json({ error: 'internal_error' });
};

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/members', membersRouter);
  // Mount your new routes here.

  app.use(errorHandler);
  return app;
}
