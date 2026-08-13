# Handle-claim recovery: pre-closure gate

Paid handle-claim recovery is not eligible for staging-money-path sign-off or
production enablement until the code and operational gates in this document are
complete.

## Governing invariant

After on-chain verification, the first durable action must bind the custody
receipt. Reservation state, quote lifecycle, feature flags, shard availability,
and policy eligibility may classify the intent as issuance, refund, recovery, or
operator review, but they must never leave verified custody unrecorded.

This is the bind-then-classify boundary. Every request path and every recovery
path must preserve it.

## Mandatory code gate

- Existing intent-bound requests remain on the intent path when new-intent
  admission is disabled. They must never fall through to the legacy
  `community_handle` rail.
- Refund reconciliation remains independently drainable while new-intent
  admission is disabled.
- The funded path must claim the verified receipt before checking shard
  reservation or other finalization eligibility.
- A released or missing shard reservation after custody binding becomes an
  explicit `refund_pending` obligation. It is not an upstream rejection and it
  must not issue a handle.
- Transient shard/provider failures remain retryable; deterministic finalization
  failures classify to refund or operator review.
- Buyer funding must not claim a receipt or issue a handle at one confirmation.
  It must use the existing safe-block/depth finality primitive (safe block when
  available, otherwise the reviewed confirmation depth) and keep the intent
  pending until that policy is satisfied. A receipt that disappears or changes
  block identity during the finality window must remain recoverable and must
  not authorize issuance.
- Underpayment, overpayment, duplicate/excess transfers, unexpected senders,
  and multiple-sender receipts must become durable custody classifications.
  They must not be dropped by a log-scan `continue` or surfaced only as a
  request error. The observed event, amount, sender(s), and disposition must
  be recorded as refund-pending or operator-review work; no handle may issue
  from an ambiguous receipt.
- Custody key epochs are immutable snapshots on intents. Until an
  epoch-indexed keyring exists, rotation is a drain-to-zero operation: do not
  rotate while any funded or `refund_pending` intent references the old epoch,
  and prove that the outstanding count is zero before changing the active key.

## Required regressions

The focused tests and staging matrix must include all of these cases:

1. Payment is included, then the shard payment reservation is swept before the
   buyer submits the claim. The receipt is claimed into the intent,
   `refund_pending` is durable, and no handle is issued.
2. An intent-bound paid claim is retried after new-intent admission is disabled.
   It remains on the intent rail and does not create a legacy-rail receipt.
3. A funded or `refund_pending` intent is reconciled while new-intent admission
   is disabled. Refund recovery continues.
4. Payment is verified before each deterministic quote, reservation, or
   allocation rejection. The observed receipt remains queryable and bound.
5. A receipt with one confirmation is not issuable. The buyer-funding path
   waits for the safe block or the configured fallback depth; a shallow reorg
   leaves the intent unissued and recoverable, and a re-inclusion can be
   finalized idempotently.
6. Underpayment and overpayment from the expected sender, a duplicate/excess
   transfer, an unexpected sender, and multiple senders each produce a
   durable observed receipt/custody disposition. None becomes an invisible
   unmatched transfer, and none issues a handle.
7. A key rotation rehearsal with an outstanding old-epoch funded intent is
   blocked (or uses an epoch-indexed keyring). The drain-to-zero path proves
   there are no funded/refund-pending intents before the active epoch changes.

The broader money-path matrix still covers late payment, missing inclusion
timestamp, replay, duplicate finalization, provider retry, worker eviction,
reconciler crash windows, refund confirmation, wrong/excess/multiple transfers,
unexpected senders, and reorg/finality behavior. The finality and custody
classification cases are release-blocking, not informational coverage.

## Rollout order

1. Land and verify the bind-then-classify repair and regressions.
2. Provision and readiness-check refund custody, including signer identity,
   token balance, gas, nonce-coordinator uniqueness, and key-epoch handling.
   ERC-20 allowance is not a handle-refund prerequisite; refunds are direct
   transfers. Allowance remains a required check for contract-mediated
   Endaoment payouts.
3. Wire and test the buyer-funding finality policy and durable custody
   classifications before staging sign-off.
4. Run the staging money-path matrix without production funds.
5. Verify every allocated shard satisfies the required schema version; do not
   hardcode the current allocation count.
6. Enable new paid-intent admissions only after all staging and readiness
   evidence is accepted.
7. Keep processing and refund recovery enabled long enough to drain every
   persisted obligation before any rollback or key rotation. Under the current
   single-epoch implementation, prove the drain-to-zero condition before
   rotating custody keys.

The admission flag controls new creation/adoption. It is not a kill switch for
already-bound intent processing or refunds.
