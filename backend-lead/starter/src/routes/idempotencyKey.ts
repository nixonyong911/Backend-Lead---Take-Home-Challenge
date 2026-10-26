import { Request } from 'express';
import { z } from 'zod';

// The client makes one UUID per user action and resends it on every retry. Missing or malformed -> 400.
const idempotencyKeyHeader = z.string({ required_error: 'Idempotency-Key header is required' }).uuid();

export function idempotencyKey(req: Request): string {
  return idempotencyKeyHeader.parse(req.header('Idempotency-Key'));
}
