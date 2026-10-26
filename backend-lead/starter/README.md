# Mini Wallet Service - Starter

This is the starter codebase for the Backend Lead take-home. The task itself is described in [`../readme.md`](../readme.md).

## Stack

TypeScript, Express, Sequelize, PostgreSQL, Jest. Money is `DECIMAL(36,18)` in Postgres, strings in JS/JSON, and all arithmetic goes through `bignumber.js` (see `src/lib/money.ts`).

## Setup

Requires Node 20+ and Docker.

```bash
cp .env.example .env
npm install
npm run db:up        # starts Postgres on localhost:5439 (dev + test databases)
npm run db:migrate   # migrates the dev database
npm test             # migrates the test database and runs the test suite
npm run dev          # starts the API on :3000
```

If port 5439 clashes with something on your machine, change it in `docker-compose.yml` and `.env`.

## Layout

```
src/
├── app.ts               # express app factory
├── index.ts             # entrypoint
├── config.ts
├── lib/money.ts         # BigNumber helpers - use these for all money math
├── db/
│   ├── sequelize.ts
│   ├── cli-config.js    # sequelize-cli config (used by npm run db:migrate)
│   ├── migrations/      # add your migrations here
│   └── models/
├── routes/
└── services/
test/                    # add your tests here
```

## Conventions to keep

- Money never touches JS `number`. Strings at the boundaries, BigNumber in between.
- Any operation writing more than one row runs in a single DB transaction (see `memberService.createMember`).
- Routes validate input with zod and delegate to services; business logic lives in services, not routes.
- New tables are created via migrations, not `sync()`.

## Trying the API

`POST /deposits`, `POST /wallets/:walletId/wagers` and `POST /withdrawals` require an `Idempotency-Key` header
(a UUID the client makes once per action and resends on retries). Without it they answer `400`.

```bash
curl -s -X POST localhost:3000/members -H 'Content-Type: application/json' -d '{"username":"alice01"}'
curl -s -X POST localhost:3000/deposits -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"memberId":"<member id>","amount":"100.50","turnoverMultiplier":1}'
curl -s -X POST localhost:3000/psp/callbacks -H 'Content-Type: application/json' \
  -d '{"pspRef":"<pspRef>","status":"completed","amount":"100.50"}'
```

Design choices and trade-offs: see `DECISIONS.md`. Part B: `DESIGN-PSP.md`.
