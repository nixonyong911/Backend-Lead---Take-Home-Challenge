import BigNumber from 'bignumber.js';
import { z } from 'zod';

// Money invariants for this codebase:
// - Money is stored as DECIMAL(36,18) in Postgres and travels as strings in JS/JSON.
// - All arithmetic on money MUST go through BigNumber. Never use JS number math on money.
BigNumber.config({ DECIMAL_PLACES: 18, ROUNDING_MODE: BigNumber.ROUND_DOWN });

export function dec(value: string | number | BigNumber): BigNumber {
  const bn = new BigNumber(value);
  if (!bn.isFinite()) {
    throw new Error(`Invalid money value: ${value}`);
  }
  return bn;
}

export const ZERO = dec(0);

// Same shape the pg driver returns for DECIMAL(36,18), so API responses look the same everywhere.
export function toMoneyString(value: BigNumber): string {
  return value.toFixed(18);
}

// Plain decimal string, at most 18 decimals (the column scale) so nothing is ever rounded.
// 15 integer digits leaves headroom for amount x turnoverMultiplier inside DECIMAL(36,18).
// No sign, no exponent ("1e2"), no JS numbers.
const MONEY_PATTERN = /^\d{1,15}(\.\d{1,18})?$/;

export const positiveMoney = z
  .string()
  .regex(MONEY_PATTERN, 'must be a decimal string with at most 18 decimal places')
  .refine((s) => dec(s).gt(0), 'must be greater than 0');
