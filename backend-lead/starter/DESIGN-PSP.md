# DESIGN-PSP: Adding the 50th PSP

**Goal:** a junior adds a new PSP (payment service provider) in one day by writing **one adapter file, its sample callbacks and one registry line**.
They never touch the code that moves money.

## Sketch: who owns what

```text
 PSP ──callback──▶ CONTROLLER ──────▶ ADAPTER ────────────▶ CORE
                   (fixed)            (junior's one file)   (fixed, owns money)
                   load config        check signature       lock funding tx row
                   pick adapter       translate their       Pending -> Completed
                   keep raw body      format to ours        credit wallet once

 Junior edits: adapter file + sample callbacks + 1 registry line. Nothing else.
```

- **Why this picture:** it shows what a reviewer must check. Only the middle box changes per PSP. The boxes on both sides are shared and owned by seniors.

## 1. The interface: the adapter is a translator

Every PSP is different: its own field names, status words, amount units and signature scheme.
We do not try to make 50 PSPs look alike. Instead, **each adapter translates between one PSP's format and our one standard shape**.
Everything outside the adapter only ever sees our shape.

```ts
interface PspAdapter {
  readonly pspKey: string;                                // "stripe", "adyen", ...; route is POST /psp/callbacks/:pspKey
  // Deposit (POST /deposits): core already saved the Pending funding tx; ask the PSP to start the payment.
  createDeposit(req: PspPaymentRequest): Promise<PspStartResult>;
  // Callback (POST /psp/callbacks/:pspKey): the controller always calls these two in this order.
  verifySignature(raw: RawRequest, secret: string): void; // throws InvalidSignatureError
  parseCallback(raw: RawRequest): PspCallback;            // their format -> ours
  // Withdrawal (POST /withdrawals): core already debited the wallet; ask the PSP to pay out.
  createWithdrawal(req: PspPaymentRequest): Promise<PspStartResult>;
}
type PspPaymentRequest = { memberId: string; amount: Money; pspRef: string };  // our pspRef, sent to the PSP
type PspStartResult    = { redirectUrl?: string };                              // e.g. a payment page
type PspCallback = {             // our standard shape, same as the Part A callback body
  pspRef: string;                // our id for the funding transaction
  status: 'pending' | 'completed' | 'failed';            // Part A words, plus 'pending' for PSPs that send it
  amount: Money;                 // value object, see section 2
};
```

**How a junior uses it (the day-one checklist):**
1. Write `src/psp/adapters/acmepay.ts`: `class AcmePayAdapter implements PspAdapter`.
2. Register it: `registry.add(new AcmePayAdapter())`.
3. Save the PSP's sample callbacks as fixtures (section 4). The shared tests then run on the new adapter automatically.

- **Why an interface:** it is the junior's checklist, enforced by TypeScript. A missing method or a wrong return shape does not compile.
- **Why the adapter only maps the format:** it changes field names, status words and units. It holds no business rules.
  Rules that apply to every PSP (valid amount, known status, state machine) live in shared code, so 50 adapters cannot each get them slightly wrong.
- **Why deposit, callback and withdrawal:** these are the three points where money crosses between us and a PSP, so each needs PSP-specific code.
  The core always moves money first (saves the Pending row, or debits the wallet) and only then calls the adapter. The adapter never writes to our DB.
- **Why no wager method:** a wager moves money only inside our own wallet. No PSP is involved, so there is nothing to translate.
  Putting it in the adapter would make 50 juniors re-implement the same money logic. It stays in the core.
- **Why no base class:** the order `verifySignature -> parseCallback -> core` lives in the **controller**, which juniors do not edit.
  An adapter cannot skip the signature check, because the controller always calls it first.

## 2. Verification and normalization

- **Signature check** lives in `verifySignature()`. PSPs differ here (HMAC-SHA256 over the raw body, MD5 over joined fields, etc.).
- **Money value object:** `new Money("50.20")` checks itself when it is created (digits only, positive, at most 18 decimals).
  `Money.fromMinor("5020", 2)` handles PSPs that send cents. Core functions only accept `Money`, so a bad amount cannot reach the ledger.
- **Status words** are mapped in `parseCallback()` (`"SETTLED"`, `"paid"`, `"00"` -> `completed`).
  An unknown word throws `UnknownStatusError`. **We never guess success.**
- **Out-of-order statuses** are handled once, in the core (built in Part A): it credits only on the move `Pending -> Completed`.
  A duplicate, a late retry or `pending` after `success` changes nothing. Adapters never think about order.
- **One fixed reply for every PSP.** PSPs retry based on the HTTP status.
  - `200`: applied.
  - `202`: stored, nothing applied, stop retrying (duplicate, unknown ref, amount mismatch, invalid move). A retry will never change the answer, and some PSPs retry any `4xx`.
  - `400` / `401`: unreadable body or bad signature. The sender is broken or is not the PSP.
  - `500`: **only our own fault** (e.g. DB down), the one case where we want a retry.

## 3. How config drives it

- **`psp_providers` table** holds settings ops can safely change without a deploy:
  `psp_key, enabled, currencies, min/max amount, base_url, secret_ref`.
- **Split by risk:** anything that changes what money *means* (amount units, signature scheme) stays in **reviewed adapter code**.
  A bad DB edit can switch a PSP off. It cannot credit 100x.
- **Secrets live in a vault.** The row stores only `secret_ref` (a path). The app reads the secret **at startup**, so secrets never sit in code or build files.
- A new PSP starts with `enabled = false`. It goes live only after its tests pass and a reviewer approves.

## 4. Testing without the real PSP

- **Recorded fixtures (required):** real sample callbacks with real signatures, from the PSP docs or sandbox, saved as JSON.
  Tests replay them through the adapter.
- **Shared conformance suite (required, automatic):** runs against every adapter in the registry:
  bad signature rejected, cents converted, unknown status rejected, every fixture gives the expected `PspCallback`.
  A junior cannot forget these tests; registering the adapter runs them.
- **Mock PSP server (CI):** a small fake PSP that sends duplicate, concurrent, late and out-of-order callbacks to the real app and DB.
  It proves the money is still credited exactly once.

## Next steps

- **One table per PSP** (e.g. `psp_acmepay_callbacks`) to keep each PSP's own fields as real columns, easy to query and report on.
  Each table needs a migration (DB script) built from a standard template, so every PSP table shares the same core columns.
  Not now: it would add a migration to the junior's day-one task. Today the raw payload is kept in the shared `psp_callbacks` table.
- **Custom replies:** we assume PSPs only read the HTTP status. If one needs its own reply body, add an optional `toResponse()` to the interface.
