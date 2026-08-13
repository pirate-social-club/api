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

The broader money-path matrix still covers late payment, missing inclusion
timestamp, replay, duplicate finalization, provider retry, worker eviction,
reconciler crash windows, refund confirmation, wrong/excess/multiple transfers,
and reorg/finality behavior.

## Rollout order

1. Land and verify the bind-then-classify repair and regressions.
2. Provision and readiness-check refund custody, including signer identity,
   balance/gas, nonce-coordinator uniqueness, and key-epoch handling.
3. Run the staging money-path matrix without production funds.
4. Enable new paid-intent admissions only after staging evidence is accepted.
5. Keep processing and refund recovery enabled long enough to drain every
   persisted obligation before any rollback or key rotation.

The admission flag controls new creation/adoption. It is not a kill switch for
already-bound intent processing or refunds.
