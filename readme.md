# Backend Lead Take-Home: Mini Wallet Service

This is my submission for the 99Tech Backend Lead take-home.
The challenge brief is in [`backend-lead/readme.md`](backend-lead/readme.md).

The task is a small wallet for a regulated, real-money platform: deposit, then wager, then withdraw.
I treated the correctness of money movement as the most important thing.
A bug here is an incident, not just a bug.

## Where to look

| What | Where |
| --- | --- |
| Code and tests | [`backend-lead/starter/`](backend-lead/starter/) |
| My trade-offs and why (locking, schema, callback edge cases, next steps, AI usage) | [`backend-lead/starter/DECISIONS.md`](backend-lead/starter/DECISIONS.md) |
| Part B: how to add the 50th PSP | [`backend-lead/starter/DESIGN-PSP.md`](backend-lead/starter/DESIGN-PSP.md) |
| How to run it | [`backend-lead/starter/README.md`](backend-lead/starter/README.md) |

The commit history is meant to be read in order. Each commit is one step:
migrations, models, balance core, services, routes, tests, then docs.

## What I built

- **Deposit flow.** `POST /deposits` creates a `Pending` funding transaction. `POST /psp/callbacks` completes or fails it.
- **Wagers.** `POST /wallets/:walletId/wagers` debits the wallet and adds to turnover.
- **Withdrawals.** `POST /withdrawals` debits the wallet only when the turnover rule is met. Otherwise it returns `422` with the outstanding amount.

## How I kept the money safe

- **One path for every balance change.** A single helper locks the wallet row, checks, updates, and writes the ledger row, all in one DB transaction.
- **Exactly-once credit.** A row lock plus a guarded `Pending -> Completed` update, backed by a unique key on the ledger. Duplicate and parallel callbacks credit once.
- **Append-only ledger.** A DB trigger blocks `UPDATE` and `DELETE` on the ledger. The wallet balance always equals the sum of its ledger rows.
- **Hostile PSP callbacks handled on purpose.** Duplicates, late replays, amount mismatch, unknown `pspRef`, invalid transitions and bad payloads each have a stated behavior.
- **Idempotency keys** on deposits, wagers and withdrawals, so a client retry never moves money twice.
- **DB constraints as the last guard.** For example `CHECK (balance >= 0)`, so a bug cannot commit a wrong state.

The full reasoning, including what I chose not to do, is in `DECISIONS.md`.

## How I tested it

- Tests run against a real Postgres, not mocks.
- Concurrency tests send 10 parallel requests: duplicate callbacks, wagers and withdrawals that would overdraw the wallet, and repeated idempotency keys.
- After every scenario, the tests check that the ledger sum equals the wallet balance.
- I checked that the tests catch real bugs: with the row locks removed, the concurrent wager and withdrawal tests fail.

## Quick start

Requires Node 20+ and Docker.

```bash
cd backend-lead/starter
cp .env.example .env
npm install
npm run db:up       # Postgres on localhost:5439
npm test            # migrates the test DB and runs all tests
npm run dev         # API on :3000
```

## AI usage

I used Claude Code to go through the design decisions as questions and answers, and then to write the code and tests from those decisions.
Every technical decision is mine, and I can explain every line. Details are in `DECISIONS.md`.
