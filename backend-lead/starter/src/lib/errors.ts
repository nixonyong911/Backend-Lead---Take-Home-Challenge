// Typed domain errors. The error handler in app.ts maps them to HTTP responses:
// { error: code, ...details } with the given status.
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, string> = {},
  ) {
    super(code);
  }
}

export class NotFound extends DomainError {
  constructor(what: string) {
    super(404, `${what}_not_found`);
  }
}

export class InsufficientFunds extends DomainError {
  constructor(balance: string, requested: string) {
    super(422, 'insufficient_funds', { balance, requested });
  }
}

export class TurnoverNotMet extends DomainError {
  constructor(requiredTurnover: string, accruedTurnover: string, outstandingTurnover: string) {
    super(422, 'turnover_not_met', { requiredTurnover, accruedTurnover, outstandingTurnover });
  }
}

export class IdempotencyKeyReused extends DomainError {
  constructor() {
    super(422, 'idempotency_key_reused');
  }
}

export class PendingDepositExists extends DomainError {
  constructor() {
    super(409, 'pending_deposit_exists');
  }
}

export class InvalidTransition extends DomainError {
  constructor(from: string, to: string) {
    super(409, 'invalid_transition', { from, to });
  }
}

// A money invariant did not hold (e.g. the DB returned a balance we did not expect).
// This is a bug, never a user error: the transaction rolls back and we answer 500.
export class InvariantViolation extends Error {}
