# DESIGN-PSP: Adding the 50th PSP

**Goal:** a junior adds a new PSP (payment service provider) in one day by writing **one adapter file and its tests**.
They never touch the code that moves money.

## Sketch: one callback, end to end

```text
  PSP  ──  POST /psp/callbacks/:pspKey   (raw body bytes kept for the signature)
                                        │
                                        ▼
┌─ SHARED CONTROLLER   seniors own · fixed order · never edited per PSP ───────┐
│ 1. load psp_providers row (by :pspKey)      missing / disabled -> 404        │
│ 2. get secret via secret_ref                from Vault, read at startup      │
│ 3. registry.get(pspKey)                     -> this PSP's adapter            │
│ 4. verifyCallback()  then  normalizeCallback()                               │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        ▼
┌─ ADAPTER   junior writes ONE file · src/psp/adapters/<pspKey>.ts ────────────┐
│ verifyCallback(raw, secret)  signature      bad -> 401                       │
│ normalizeCallback(raw)  their format -> ours                                 │
│   status word -> pending|completed|failed   unknown -> 400                   │
│   amount -> new Money() or fromMinor()      invalid -> 400                   │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        ▼  PspCallback { pspRef, status, amount }  (same shape as A2)
┌─ CORE   seniors own · same for every PSP · built in Part A ──────────────────┐
│ find funding transaction by pspRef, lock    not found, stored -> 202         │
│ amount differs from funding transaction     no credit, Failed + flag -> 202  │
│ Pending -> Completed                        credit + wallet_txs ONCE -> 200  │
│ Pending -> Failed                           no money moves -> 200            │
│ duplicate, late retry, pending after done   no-op -> 202                     │
│ failed after completed (invalid move)       rejected, flag -> 202            │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        ▼
┌─ GLOBAL ERROR MIDDLEWARE   one fixed response for every PSP ─────────────────┐
│ every typed error is logged the same way, same reply shape                   │
│ our own fault (e.g. DB down)                500 -> the PSP retries           │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1. The interface

Names, routes and fields follow Part A exactly. The only change: the callback route gets a `:pspKey` so we know which PSP is calling.

```ts
interface PspAdapter {
  readonly pspKey: string;                                       // "stripe", "adyen", ...

  // A1. Create a deposit (POST /deposits). Core already saved the Pending funding transaction.
  createDeposit(req: CreateDepositRequest): Promise<PspStartResult>;
  // A2. Handle the PSP callback (POST /psp/callbacks/:pspKey). Two steps, always in this order:
  verifyCallback(raw: RawRequest, secret: string): void;         // throws InvalidSignatureError
  normalizeCallback(raw: RawRequest): PspCallback;               // throws InvalidPayload / UnknownStatus
  // A4. Withdrawals (POST /withdrawals). Core already debited the wallet.
  createWithdrawal(req: CreateWithdrawalRequest): Promise<PspStartResult>;
}
type CreateDepositRequest    = { memberId: string; amount: Money; pspRef: string };  // A1 body + our pspRef
type CreateWithdrawalRequest = { memberId: string; amount: Money; pspRef: string };  // A4 body + our pspRef
type PspStartResult          = { pspRef: string; redirectUrl?: string };              // e.g. a payment page
type PspCallback = {                                             // same shape as the A2 callback body
  pspRef: string;                                                // our shared transaction id
  status: 'pending' | 'completed' | 'failed';                    // A2 words, plus 'pending' for PSPs that send it
  amount: Money;                                                 // value object, see section 2
};
```

- **Why an interface:** each adapter has one job, which is to talk to one PSP in its own format (single responsibility).
  We add PSPs by adding classes, not by editing old code (open/closed).
- **The adapter only talks to the PSP. The core owns the money.** The core saves the funding transaction, moves it
  `Pending -> Completed / Failed`, updates the wallet and writes `wallet_txs`. `pspRef` alone tells the core which
  funding transaction (deposit or withdrawal) a callback belongs to.
- **A3. Record wagers is not in this interface.** A wager moves money only inside our own wallet. No PSP is involved, so it stays in the core.
  Putting it in every adapter would make 50 juniors re-implement the same money logic.
- **Why it is still safe without a base class:** the order `verifyCallback -> normalizeCallback -> core` lives in the **shared controller**, which juniors do not edit.
  An adapter cannot skip verification, because the controller always calls it first.

## 2. Verification and normalization

- **Signature check** lives in `verifyCallback()`. PSPs differ here (HMAC-SHA256 over the raw body, MD5 over joined fields, etc.).
  The controller keeps the **raw body bytes**, because a signature is computed over the exact bytes, not over parsed JSON.
- **Money value object**: `new Money("50.20")` checks itself when it is created (digits only, positive, max 18 decimals).
  `Money.fromMinor("5020", 2)` handles PSPs that send cents. Core functions only accept `Money`, so a bad amount cannot reach the ledger.
- **Status words** are mapped in `normalizeCallback()` (`"SETTLED"`, `"paid"`, `"00"` -> `completed`).
  An unknown word throws `UnknownStatusError`. **We never guess success.**
- **Core rules are the same for every PSP** (built in Part A). The core finds the funding transaction by `pspRef` and locks the row.
  It credits only on the one move `Pending -> Completed`. A duplicate, a late retry or `pending` after `success` changes nothing.
  If the amount differs from the funding transaction, nothing is credited and it is flagged for review.
- **Standard errors + one fixed response.** All errors are typed. One global middleware logs them the same way and
  returns the same reply shape for every PSP (status codes are in the sketch).
  PSPs retry based on the HTTP status. `200` means "applied". `202` means "stored, nothing applied, stop retrying"
  (duplicate, unknown ref, amount mismatch, invalid move): a retry will never change the answer, and some PSPs retry any `4xx`.
  A bad signature or an unreadable body gets `4xx`: the sender is broken or is not the PSP.
  **Only our own fault returns `500`**, the one case where we want a retry.

## 3. How config drives it

- **`psp_providers` table** holds settings ops can safely change without a deploy:
  `psp_key, enabled, currencies, min/max amount, base_url, secret_ref`.
- **Split by risk:** anything that changes what money *means* (amount units, signature scheme) stays in **reviewed adapter code**.
  A bad DB edit can switch a PSP off. It cannot credit 100x.
- **Secrets live in a vault.** The row stores only `secret_ref` (a path). The app reads the secret **at startup**, not at build, so secrets never sit in build files.
- A new PSP starts with `enabled = false`. It goes live only after its tests pass and a reviewer approves.

## 4. Testing without the real PSP

- **Recorded fixtures (required):** real sample callbacks with real signatures, from the PSP docs or sandbox, saved as JSON.
  Tests replay them through the adapter.
- **Shared conformance suite (required, automatic):** runs against every adapter in the registry:
  bad signature rejected, cents converted, unknown status rejected, every fixture gives the expected `PspCallback`.
  A junior cannot forget these tests; registering the adapter runs them.
- **Mock PSP server (CI):** a small fake PSP that sends duplicate, concurrent, late and out-of-order callbacks to the real app and DB.
  It proves the money is still credited exactly once.

**Assumption:** these are payment PSPs that only read the HTTP status code. If a PSP needs its own reply format, we would add an optional `toResponse()` to the interface.
