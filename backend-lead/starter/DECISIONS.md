# DECISIONS

## Money correctness: how every balance change works

- One shared helper does **every** balance change: deposit credit (PSP callback), wager debit and withdrawal debit.
  - No other code touches `wallets.balance` or the turnover totals directly.
  - It requires the DB transaction as an argument, so no query runs outside it by mistake.
- Steps, all inside one DB transaction:
  1. **Lock.** `SELECT ... FOR UPDATE` on the wallet row (a row lock: others wait until we finish). Callbacks lock the funding tx first, then the wallet. One fixed order avoids deadlocks (two transactions waiting on each other forever).
  2. **Check.** On the locked row: enough balance, turnover met. Work out the expected end values.
  3. **DB does the math.** `UPDATE wallets SET balance = balance + amount` (and turnover totals) `RETURNING` the new values.
  4. **Assert.** Returned values must equal the expected ones.
  5. **Ledger.** Insert the `wallet_txs` row with `balance_after` = the returned balance.
  6. **Commit.**
- A failed assert means a bug (nothing else can change the locked row): roll back, `500`, alert. Never retried.
- DB constraints as the last guard: `CHECK (balance >= 0)` and `>= 0` on both turnover totals. A bug cannot commit a wrong state.
- Amounts are decimal strings with at most 18 decimal places (the column scale). Longer ones are rejected, never rounded.
- Assumed limits: 15 integer digits, multiplier at most 100, so `amount x multiplier` fits the column.
- Three layers: **prevent** (lock, checks), **refuse** (DB constraints), **detect** (assert, reconciliation in tests).
- Why not check before the lock: the value can be stale. Under the lock, requests wait their turn.

## PSP callback edge cases

### Amount mismatch

- If a `completed` callback has a different amount from the deposit, we do **not** credit the wallet.
- The deposit moves `Pending -> Failed` with `failure_reason = 'amount_mismatch'`. We return `202`.
- A later callback with the correct amount cannot credit it (an invalid transition, see below). The member must start a new deposit.
- Ops review these by `failure_reason`; the raw payload is kept.

### Unknown `pspRef`

- We store the raw callback payload for audit and return `202` so the PSP stops retrying.
- Why: a 4xx or 5xx can cause endless retries.

### Late duplicate callbacks

- A repeat of the status the deposit already has (e.g. `completed` for a `Completed` deposit) returns `202` and changes nothing.
- Only one delivery credits: funding tx row lock plus a guarded update (`WHERE status = 'Pending'`); we credit only if a row changed.

### Malformed callback

- Bad JSON shape, unknown status word or invalid amount (`"0"`, `"-1"`, `"1e2"`): stored with outcome `invalid_payload`, then `400`.
- Why `4xx`: the sender is broken; a retry cannot help.

### Invalid transitions

- A callback asking for a different end state than the deposit already has: `failed` after `Completed`, or `completed` after `Failed`.
- Rejected: nothing is applied, balance unchanged, outcome `invalid_transition`, logged for review.
- We return `202` with the current state. "Rejected" means "not applied"; a 4xx would only make the PSP retry.

## Schema choices

### Funding transactions

- One `funding_transactions` table for both deposits and withdrawals.
- Columns: `type` (`deposit` / `withdrawal`), `status`, `amount`, `psp_ref` (unique), `turnover_multiplier` (null for withdrawals), `failure_reason`.
- Why: one state machine, one place to look.

### Ledger (`wallet_txs`)

- One row per balance change: `wallet_id`, `type` (`deposit` / `wager` / `withdrawal`), signed `amount` (+ credit, - debit), `balance_after`, `reference_id`.
- Unique `(reference_id, type)`: the database itself refuses a second credit for the same deposit (last line of defense).
- `balance_after` shows the exact row where something went wrong.
- Append-only is enforced by a DB trigger: `UPDATE` and `DELETE` on `wallet_txs` and `psp_callbacks` raise an error.

### Turnover

- Two running totals per wallet: `wallets.required_turnover` and `wallets.accrued_turnover`.
- Both are updated under the same wallet lock and in the same DB transaction as the ledger write, so they never drift from the money.
- Why columns, not a SUM per request: fast check, no full-history scan. They can still be rebuilt from history.
- The `422` body gives a full breakdown (decimal strings):
  - `{ "error": "turnover_not_met", "requiredTurnover", "accruedTurnover", "outstandingTurnover" }`
- The totals are **never reset**, not even after a withdrawal.
  - Known limit: spare turnover can unlock a later deposit straight away. A business-rule change, out of scope.

### One pending deposit at a time

- A member can have only one `Pending` deposit. A second `POST /deposits` gets `409`.
- Why:
  - **No double charge.** Two tabs or devices (each with its own idempotency key) cannot start two payments for one intent.
  - **Clear reconciliation.** One payment in flight per member; ops never guess which callback belongs to which attempt.
  - **Simple deposit limits.** Responsible-gambling limits are easy to check with at most one pending amount.
- Cost: if the PSP never calls back, the member is stuck. Next step: expire old `Pending` deposits.

### Raw callback audit (`psp_callbacks`)

- Append-only table. Every delivery is stored: known or unknown `pspRef`, duplicate or not.
- Columns: raw `payload`, `received_at`, and `outcome` (`credited` / `failed` / `duplicate` / `invalid_transition` / `amount_mismatch` / `unknown_ref` / `invalid_payload`).

## Idempotency keys (one key per user action)

- The **client** makes a UUID once per action (e.g. "bet 10 on this game") and resends it on every retry in an `Idempotency-Key` header.
- Required on `POST /deposits`, `POST /wallets/:walletId/wagers` and `POST /withdrawals`. Missing key: `400`.
- Table `idempotency_keys`: unique `(member_id, key)`, `request_hash` (fingerprint of path and body), saved response.
- Steps, inside the **same DB transaction** as the money change:
  1. `INSERT ... ON CONFLICT DO NOTHING` the key row.
  2. New key: run the action, save the response, commit.
  3. Same key, same request: return the saved response. No money moves.
  4. Same key, different request: `422`. The client reused a key for another action.
- Same key in parallel: Postgres makes the second insert wait for the first commit. No extra lock needed.
- Key and money change commit together; a crash leaves nothing, so a retry runs cleanly. 
- The fingerprint uses the amount exactly as sent: `"10"` then `"10.00"` with one key is `422`.
- Callbacks use `pspRef` as their key: the PSP sends it back on every retry.
- Why per action: a server-made id is new on every request, so it cannot spot a retry.

## Testing

- Mindset: attacker plus unreliable network. Same money path many times, at once, or late.
- Real Postgres. Concurrency tests fire 10 parallel requests (`Promise.all`); Sequelize pool raised to 20.
- Proof they bite: with the row locks removed, the concurrent wager and withdrawal tests fail.
- After every scenario: ledger sum == wallet balance; turnover totals match history.
- Hostile PSP / replayed callbacks:
  1. Duplicate `completed` callback, sent one after another: credited once.
  2. 10 identical `completed` callbacks in parallel: credited once.
  3. Old `completed` callback replayed later: no change.
  4. `failed` after `Completed`, and `completed` after `Failed`: rejected, balance unchanged.
  5. Amount mismatch: `"100.5"` equals `"100.50"` (compared as decimals); `"100.49"`, `"0"`, `"-1"`, `"1e2"` are a mismatch or rejected.
- Draining the wallet:
  6. 10 parallel wagers that together exceed the balance: no overdraw.
  7. 10 parallel withdrawals that together exceed the balance: no overdraw.
- Turnover lock:
  8. Blocked, then a wager, then unblocked; `422` shows the full breakdown.
  9. Accrued exactly equal to required: allowed.
  10. Multiplier `0`: can withdraw right away.
- Idempotency:
  11. Same key sent 10 times in parallel: one wager, all get the same response.
  12. Same key, different amount: `422`.

## Status codes

| Code | Meaning |
|---|---|
| `200` | Success. Callback applied. |
| `201` | Deposit, wager or withdrawal created (also on an idempotent replay). |
| `202` | Success with an issue: duplicate callback, unknown `pspRef`, amount mismatch or invalid transition. PSP stops retrying. |
| `400` | Invalid input or callback payload, or missing/non-UUID `Idempotency-Key`. |
| `404` | Member or wallet not found. |
| `409` | Member already has a `Pending` deposit. |
| `422` | Not enough balance, turnover not met, or idempotency key reused for a different request. |
| `500` | Assert failed: a bug. Rolled back and alerted. |

## Next steps (with more time)

- Ledger reconciliation with checkpoints (a stored, verified summary up to a given row): a cron job sums only newer rows and alerts on any difference. Cost depends on new activity, not 10M+ rows.
- Partition `wallet_txs` by month (Postgres table partitioning: one table per month behind one name).
  - Old months move to cheaper storage; rows are never deleted.
- Testcontainers: each test run gets a fresh Postgres in Docker.

## AI usage

- Claude Code was used to read the challenge and walk through the design decisions as a question-and-answer session. Every technical decision above was decided by me.
- Claude Code then wrote the code and tests from these decisions.