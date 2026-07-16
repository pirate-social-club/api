# Story purchase settlement broadcast journal

Status: design proposal; no implementation is authorized by this document.

## Problem

Story-native purchases currently reserve one `purchase_settlement_effects` row, call a high-level
SDK operation, and record the transaction reference only after the call returns. A worker can crash
or lose its RPC response after broadcast but before that reference is stored. The row then remains
`submitted`, or is marked `failed` even though value may have moved. Retrying by timeout can pay the
royalty twice.

One purchase can involve several Story transactions:

1. wrap native IP into WIP when the settlement signer lacks WIP;
2. approve WIP spending when allowance is insufficient;
3. pay WIP into the child royalty vault;
4. transfer child-vault revenue to each parent vault;
5. mint the buyer entitlement.

The current Story SDK may prepare and broadcast the wrap, approval, and payment internally. A
durable journal cannot safely sit outside that opaque call. Fix 2 therefore requires an explicit,
versioned transaction plan and a wallet-scoped executor that owns every nonce, signature, broadcast,
and receipt transition. The later sweeper may converge journaled work, but it must never invent or
blindly rebroadcast a value-bearing transaction.

## Goals

- Persist immutable call identity, signer nonce, signed transaction, and transaction hash before
  the first broadcast attempt.
- Serialize nonce ownership across every community using the same Story settlement wallet.
- Represent each on-chain subtransaction independently, including prerequisite wrap and approval.
- Resume safely after a crash at every storage, signing, broadcast, receipt, and mirror boundary.
- Re-broadcast only the exact persisted signed transaction, never a newly signed replacement for an
  ambiguous operation.
- Finalize purchase and delivery rows only after all required transactions reach final confirmation.
- Make partial progress observable and operationally recoverable without granting delivery early.

## Non-goals

- This change does not sweep stale effects. The sweeper is Fix 3 and depends on this journal.
- This change does not change buyer USDC finality or the global receipt-claim design.
- This change does not solve settlement-wallet WIP solvency monitoring.
- This change does not automatically compensate a reverted, replaced, or deeply reorged payment.
- This change does not preserve the high-level SDK call when it cannot expose every raw transaction
  before broadcast.

## Safety invariants

These are merge-blocking invariants, not aspirations.

1. **One wallet, one nonce owner.** Only the Durable Object keyed by
   `(chain_id, signer_address)` may allocate a nonce for the Story settlement signer.
2. **Persist before broadcast.** No chain primitive may broadcast until the exact signed bytes,
   derived hash, nonce, call-identity hash, and plan-step identity are committed in DO storage.
3. **Immutable transaction identity.** Once a step has signed bytes or a transaction hash, its
   chain, signer, nonce, target, value, calldata, and call-identity hash cannot change.
4. **No ambiguous fresh signing.** A step in `prepared`, `broadcast`, `mined`,
   `reconciliation_required`, `reverted`, or `replaced` can never return to a state that signs a new
   transaction.
5. **Exact replay only.** When a transaction is absent and its nonce is still unused, recovery may
   rebroadcast only the stored signed bytes.
6. **Nonce consumption fences replay.** If the journaled hash is absent and the chain's latest nonce
   is greater than the journaled nonce, the step becomes `replaced`; it is never rebroadcast.
7. **Dependencies are finality-gated.** A step may reserve a nonce only after every dependency is
   `confirmed`, except an explicitly modeled independent prerequisite.
8. **Effect confirmation is derived.** A purchase settlement effect is `confirmed` only when every
   required plan step is `confirmed` and its immutable result matches the effect request.
9. **Delivery remains last.** Local purchase, entitlement, and delivery rows are not finalized until
   all royalty payment, parent transfer, and entitlement steps are confirmed.
10. **Terminal means no automatic value movement.** `reverted`, `replaced`, and post-finality
    inconsistency require an explicit operator or compensation workflow. A generic retry cannot
    create a new value-bearing step.

## Ownership model

### Community-shard ledger

`purchase_settlement_effects` remains the business-level ledger. It owns:

- community, quote, purchase, effect kind, and effect key;
- immutable business request and request fingerprint;
- aggregate status and failure classification;
- coordinator plan reference;
- the confirmed business result used by local settlement finalization.

It does not own raw signed transactions. Community shards cannot coordinate a globally shared
wallet nonce and should not store signing material.

### Wallet-scoped Story coordinator

A new Story chain-executor DO is keyed by normalized Story chain ID and settlement signer address.
It owns:

- the durable inbox of settlement plans;
- global nonce allocation for that signer;
- immutable plan steps and dependency ordering;
- raw signed transactions and their hashes;
- signing leases and compare-and-swap versions;
- broadcast, receipt, finality, replacement, and retry scheduling.

The coordinator is authoritative for transaction state. The shard row is a monotonic mirror. A
mirror outage can delay purchase finalization but cannot cause a second transaction.

## Data model

### Additive shard changes

Add fields to `purchase_settlement_effects`:

- `request_fingerprint TEXT`: versioned hash of immutable business inputs;
- `coordinator_plan_ref TEXT`: immutable coordinator plan identifier;
- `coordinator_state TEXT`: monotonic aggregate state;
- `coordinator_version INTEGER`: last mirrored plan version;
- `reconciliation_reason TEXT`: bounded machine-readable reason;
- `last_reconciled_at TEXT`;
- `finality_confirmed_at TEXT`.

Keep `settlement_ref` as the canonical confirmed result for compatibility. Do not overload it with
an ambiguous or merely broadcast hash.

Add a shard mirror table, `purchase_settlement_transactions`, with one row per coordinator step:

- `purchase_settlement_transaction_id`;
- `purchase_settlement_effect_id`;
- `step_key` and `step_kind`;
- `ordinal`;
- `call_identity_hash`;
- `coordinator_step_ref`;
- `state`;
- `nonce`, `tx_hash`, `block_number`, `block_hash`;
- `attempt_count`, `last_error_code`;
- `prepared_at`, `broadcast_at`, `mined_at`, `confirmed_at`, `updated_at`.

The shard mirror intentionally omits signed bytes. Unique constraints cover
`(purchase_settlement_effect_id, step_key)`, `coordinator_step_ref`, and non-null
`(chain_id, signer_address, nonce)` if those identity fields are mirrored.

### Coordinator plan

The DO stores a plan header and immutable step rows.

Plan header:

- `plan_ref`, `plan_version`, `request_fingerprint`;
- community, quote, purchase, and business-effect references;
- chain ID and signer address;
- aggregate state and version;
- created, updated, and terminal timestamps.

Step row:

- `step_ref`, `step_key`, `kind`, `ordinal`;
- dependency step references;
- target address, native value, calldata, and `call_identity_hash`;
- nonce, signed transaction, and transaction hash;
- state and CAS version;
- signing claim token and expiry;
- receipt block/hash/status and finality observations;
- attempt count, next attempt, and bounded error code.

The coordinator derives all identifiers. Callers cannot choose a colliding plan or step key.

## Call identity

`call_identity_hash` uses a canonical, versioned encoding of:

- schema version;
- chain ID and signer address;
- community, quote, purchase, effect kind, and effect key;
- plan step kind and ordinal;
- contract target;
- native value;
- calldata bytes;
- settlement token and amount where applicable;
- child and parent IP IDs where applicable;
- entitlement token, buyer address, and purchase reference where applicable.

The hash is computed independently by the request layer and coordinator. A mismatch rejects the
plan before nonce allocation. A repeated plan request must match every immutable field exactly.

## Explicit transaction plan

Gate A established that Story SDK 1.4.4 cannot return the complete unsigned transaction set:
`payRoyaltyOnBehalf` omits conditional wrap/approval work and `transferToVault` ignores
`encodedTxDataOnly` and broadcasts. The v1 path is therefore verified, pinned contract addresses
and ABIs with pure local builders. The high-level SDK must not remain on the broadcast boundary, and
no adapter may claim durability while retaining a hidden broadcast. See
`docs/spikes/story-settlement-encoded-calldata.md` and API PR #497.

The initial plan kinds are:

- `wip_wrap`: wrap a fixed native amount into WIP;
- `wip_approve`: approve the exact required spender/allowance policy;
- `story_royalty_payment`: pay WIP on behalf of the purchase;
- `story_parent_vault_transfer`: one step per normalized parent IP ID;
- `story_entitlement_mint`: mint the purchase entitlement.

Planning occurs inside the wallet-scoped coordinator so WIP balance and allowance reads are ordered
with other plans for the same signer. The resulting wrap amount and approval call become immutable
before signing. An external top-up may make a planned wrap unnecessary economically, but executing
the already persisted wrap remains safe; changing or dropping a prepared step does not.

Parent IDs are normalized, deduplicated, and sorted before step keys and ordinals are derived. The
entitlement step depends on the royalty payment and every parent transfer. Local delivery depends on
the entitlement step and aggregate plan confirmation.

## State machine

Each step has one of these states:

- `planned`: immutable call stored; no nonce allocated;
- `reserving`: nonce allocated or signing lease active; no signed bytes yet;
- `failed_prebroadcast`: preparation failed before signed bytes existed; same step may retry;
- `prepared`: signed bytes, hash, nonce, and call identity durably stored; not known broadcast;
- `broadcast`: exact signed transaction accepted, already known, or pending;
- `mined`: canonical receipt observed but finality threshold not reached;
- `confirmed`: successful receipt reached finality;
- `reverted`: final receipt has failure status;
- `replaced`: journaled transaction absent and its nonce consumed by another transaction;
- `reconciliation_required`: RPC or chain evidence is insufficient or contradictory.

Allowed transitions:

```text
planned -> reserving
reserving -> prepared | failed_prebroadcast
failed_prebroadcast -> reserving
prepared -> broadcast | reconciliation_required
broadcast -> broadcast | mined | reverted | replaced | reconciliation_required
mined -> mined | confirmed | broadcast | reconciliation_required
reconciliation_required -> broadcast | mined | confirmed | reverted | replaced
```

`confirmed`, `reverted`, and `replaced` are terminal for that transaction identity. A new business
attempt after `reverted` is a separately authorized generation with a new effect/plan identity; it
is not a retry transition and is out of scope for the generic reconciler.

## Execution algorithm

1. Reserve the shard business effect using immutable request matching.
2. Enqueue or retrieve the coordinator plan. Duplicate requests must match the full fingerprint.
3. Persist the coordinator plan reference on the shard effect before waiting for completion.
4. The DO alarm selects the oldest runnable plan and first dependency-satisfied step.
5. Sample chain pending nonce, atomically advance the DO nonce counter, and CAS the step to
   `reserving` with that nonce.
6. Acquire a bounded signing lease. Build and validate the EIP-1559 transaction against the stored
   call identity, sign it, derive its hash, then CAS signed bytes/hash to `prepared`.
7. Broadcast the exact stored bytes. Record `broadcast`, or classify ambiguous errors using receipt,
   transaction, and nonce evidence.
8. Reconcile receipt inclusion and finality on alarms. Do not hold an HTTP request open as the owner
   of progress.
9. When a step confirms, release its dependents. When every required step confirms, mark the plan
   confirmed.
10. Mirror coordinator state and step evidence into the community shard using version-fenced,
    monotonic updates.
11. Finalize local purchase and delivery rows only from a confirmed plan mirror, with a direct
    coordinator lookup as the repair path if the mirror is stale.

HTTP settlement may perform bounded polling for user experience, but timeouts only return
`settlement_pending`; they never mark a broadcast-capable effect failed.

## Reconciliation rules

For a step with persisted signed bytes and hash:

1. Read the transaction receipt and transaction by the journaled hash.
2. If a canonical successful receipt exists, record `mined`; advance to `confirmed` only after the
   configured finality rule.
3. If a canonical failed receipt exists, advance to `reverted`.
4. If the transaction is pending, remain `broadcast`.
5. If hash and receipt are absent, compare the signer's latest nonce with the journaled nonce:
   - latest nonce greater than journaled nonce: `replaced`;
   - latest nonce less than or equal to journaled nonce: rebroadcast the exact signed bytes;
   - RPC disagreement or unavailable evidence: `reconciliation_required`.
6. “Already known”, “nonce too low”, and transport timeouts are evidence prompts, not success or
   permission to sign again.

The reconciler never modifies target, calldata, value, gas fields, or nonce. Fee replacement is not
part of the first version because it creates a second signed hash for one nonce. If later required,
replacement must be a first-class, policy-bounded state machine that links every candidate hash and
proves identical call/value semantics.

This deliberately accepts wallet-wide head-of-line blocking when a prepared transaction is
underpriced: later nonces cannot confirm before it. Before canary admission, v1 therefore requires
a conservative but capped EIP-1559 fee policy versioned into the plan, a critical alert on maximum
broadcast age, and an audited operator runbook for manual same-nonce replacement. The runbook must
preserve target, value, calldata, and call identity; record every candidate hash; and freeze new
admission while replacement evidence is reviewed. Manual replacement is incident response, not an
automatic reconciler transition.

## Finality and reorg policy

Use a Story-specific finality policy:

- prefer a supported safe/finalized block tag;
- otherwise require a configured confirmation depth;
- verify the receipt block hash against the canonical block at that height;
- store receipt block number/hash before declaring finality.

A pre-finality reorg moves `mined` back to `broadcast` when the same transaction returns to the
mempool, or to `reconciliation_required`/`replaced` according to nonce evidence. A contradiction
after `confirmed` raises a critical incident and freezes local finalization/compensation decisions;
the normal executor must not rebroadcast.

Finality configuration is versioned into the plan so a policy deployment cannot reinterpret an
already admitted transaction.

## Crash matrix

| Crash point | Durable evidence | Recovery |
| --- | --- | --- |
| Before plan insert | None | Retry request creates the same derived plan. |
| After plan insert, before shard mirror | Coordinator plan | Retry retrieves it and repairs the mirror. |
| After nonce reservation, before signing | Nonce + `reserving` | Expired signing lease retries signing the same call with the reserved nonce. |
| Reserved nonce becomes permanently unsigned and its plan is cancelled or terminal | Nonce + no signed bytes | Admission freezes until the approved abandoned-nonce repair closes or safely reassigns the gap; later nonces must not continue indefinitely past an unresolved gap. |
| After signing, before `prepared` CAS | No durable signed bytes | Lease expiry rebuilds and signs with the reserved nonce; the lost bytes were never durable and broadcast was prohibited. |
| After `prepared` CAS, before broadcast | Signed bytes/hash/nonce | Alarm broadcasts the exact stored bytes. |
| During/after broadcast response loss | Signed bytes/hash/nonce | Receipt/transaction/nonce reconciliation; never fresh-sign. |
| After receipt, before state update | Chain receipt + journal hash | Alarm re-reads and records `mined`/`reverted`. |
| After finality, before shard mirror | Confirmed coordinator step | Mirror repair copies monotonic state. |
| After all steps, before local purchase finalization | Confirmed plan | Retry finalizes local rows without chain writes. |

## Concurrency and fencing

- The DO name includes chain ID and signer address, so communities cannot allocate competing nonces.
- Plan and step writes use monotonically increasing versions and compare-and-swap updates.
- Signing leases include an unguessable token and expiry; only the lease holder may persist signed
  bytes.
- The shard accepts a coordinator mirror only when its plan reference matches and the incoming
  coordinator version is not older.
- A shard effect with a coordinator plan reference can never re-enter the legacy direct SDK path.
- The new coordinator refuses admission when the settlement signer key does not derive the address
  used to name the DO.

## Failure classification

Errors stored or emitted by the executor are bounded codes, not raw RPC payloads or signed bytes:

- `preparation_config_invalid`;
- `preparation_balance_insufficient`;
- `preparation_simulation_reverted`;
- `signing_failed`;
- `broadcast_rpc_unavailable`;
- `receipt_pending`;
- `receipt_reverted`;
- `transaction_replaced`;
- `finality_pending`;
- `canonical_block_mismatch`;
- `chain_evidence_inconsistent`.

Raw signed transactions remain inside DO storage and must never appear in logs, shard metadata,
alerts, API responses, or audit-event payloads.

## Admission and settlement behavior

- New purchases are admitted only when the coordinator binding, signer identity, Story contracts,
  gas policy, and finality policy are configured.
- Insufficient WIP/native balance before signing is `failed_prebroadcast` and retryable after funding.
- Once any value-bearing step is `prepared`, the purchase remains pending until reconciliation. The
  client cannot substitute another plan or funding transaction to bypass it.
- Rights holds continue to block before new plan admission. A hold appearing after broadcast freezes
  delivery and requires an operator decision; it cannot erase an on-chain payment.
- Parent transfers and entitlement mint are separate steps, so partial progress is explicit and the
  buyer remains undelivered until all dependencies confirm.
- Finality-gated serial steps make settlement asynchronous at product level. The web integration is
  part of Fix 2: checkout must persist and render `settlement_pending`, poll with bounded backoff,
  survive navigation/reload, and clearly distinguish processing from failed or delivered. Production
  admission is blocked until that pending-purchase flow is verified against staging.

## Deployment sequence

1. Land and deploy additive shard migrations and DO schema support. Existing readers must tolerate
   null coordinator fields. Do not alter execution behavior. Declare the shard migration as an
   unconditional API schema requirement using the established `community-schema-requirements.json`
   mechanism, and roll/verify it across the fleet with `core/scripts/community/lib` before enabling
   admission.
2. Deploy the explicit Story transaction builder and validate call identities against the existing
   SDK in non-broadcast shadow tests. Prove every possible SDK subtransaction is represented.
3. Deploy the coordinator with admission disabled. Test nonce allocation, signing, exact-byte
   rebroadcast, receipt reconciliation, and mirror repair against staging.
4. Enable new-plan admission for a single staging community and settlement signer. Keep legacy
   direct settlement disabled for any effect carrying a coordinator plan reference.
5. Run the full purchase-to-parent-to-entitlement-to-delivery E2E plus injected crash tests at every
   matrix boundary.
6. Canary production by explicit community allowlist, then expand only after coordinator backlog,
   nonce gaps, replacement count, and reconciliation age remain healthy.
7. Disable new legacy Story settlements. Do not auto-migrate old ambiguous `submitted` rows; classify
   them separately using operator-reviewed chain evidence.
8. After all admitted legacy work is resolved, remove the direct SDK broadcast path in a later PR.

Migration deployment is fail-closed: schema and DO support land before the feature flag can admit a
plan. A schema preflight must verify every target community template/version before enabling the
flag.

Until coordinator integration ships, production retains the legacy stuck-`submitted` risk. The
read-only Story diagnostic landed in API PR #499; its buyer-funding extension and per-classification
legacy-disposition runbook are tracked in API PR #502. These tools list bounded identifiers,
transaction references, chain-specific receipt/transaction evidence, and signer nonce evidence.
They never mutate effects or rebroadcast.

## Rollback

Rollback means disabling **new plan admission**, not stopping the coordinator.

- Already admitted plans and DO alarms must continue reconciling through terminal state.
- Never deploy older code that can route a journaled effect into the legacy SDK path.
- Never delete coordinator or mirror data during rollback.
- If the transaction builder is defective before any step is prepared, disable admission and mark
  affected plans `failed_prebroadcast` after evidence review.
- If any step is prepared or later, freeze expansion and let exact-transaction reconciliation run;
  do not generate replacement business effects.

## Required tests

### State-machine tests

- Every allowed transition succeeds and every unlisted transition fails.
- Immutable request/call fields reject conflicting reuse.
- Expired signing claims cannot overwrite a newer CAS version.
- A prepared or later step can never enter signing again.
- Dependencies cannot reserve nonces before prerequisite confirmation.

### Fault-injection tests

Inject a crash after each row in the crash matrix and prove convergence without a second call
identity or nonce. Include RPC timeout before and after broadcast, “already known”, nonce-too-low,
receipt timeout, and mirror failure.

### Chain-evidence tests

- pending, successful, and reverted receipts;
- absent hash with unused nonce exact-byte rebroadcast;
- absent hash with consumed nonce replacement;
- receipt block-hash mismatch and pre-finality reorg;
- safe-block support and confirmation-depth fallback.

### Integration tests

- concurrent purchases from different community shards sharing one signer;
- WIP wrap + approval + payment with a crash between every subtransaction;
- multiple parents with one transfer pending or reverted;
- entitlement mint pending after confirmed royalty transfers;
- confirmed coordinator plan with missing shard mirror and missing local purchase rows;
- rights hold arriving before admission and after payment broadcast;
- process restart and DO alarm recovery without an HTTP retry.

### Invariant assertions

For every admitted step:

- at most one immutable call identity exists;
- at most one nonce exists;
- every broadcast hash derives from the stored signed bytes;
- any rebroadcast uses byte-for-byte identical signed data;
- no purchase is delivered unless all required steps are final-confirmed;
- no `reverted` or `replaced` step has an outgoing automatic broadcast transition.

## Observability and operations

Expose bounded metrics and operator views for:

- plans and steps by state and age;
- oldest `reserving`, `prepared`, `broadcast`, `mined`, and
  `reconciliation_required` step;
- signer next nonce versus chain pending/latest nonce;
- replacements, reverts, reorgs, and exact-byte rebroadcast counts;
- shard mirror lag and locally unfinalized confirmed plans;
- WIP/native insufficiency before signing.
- maximum broadcast age and fee-policy version.

Alert on nonce gaps, broadcast age above policy, any `replaced` value-bearing step, finality
contradiction, reconciliation age above policy, or confirmed plans whose local purchase remains
absent. Operator actions must be audited and may classify evidence, freeze admission, or execute the
approved abandoned-nonce/manual-replacement runbook; they must not silently edit signed bytes, call
identity, nonce, or transaction hash.

## Decision gates before implementation

1. **Gate A — decided: SDK shortcut rejected.** Static inspection of pinned Story SDK 1.4.4 proved
   that `payRoyaltyOnBehalf` returns before conditional WIP wrap/approval planning and
   `transferToVault` broadcasts even when `encodedTxDataOnly` is requested. No transaction was
   signed or broadcast during the spike. Fix 2 proceeds only with explicit local builders; adopting
   an upstream unsigned-plan API would require a new equivalence gate.
2. Inventory and pin the Aeneid addresses and exact ABIs for WIP deposit, exact allowance approval,
   royalty payment, LAP `transferToVault`, and entitlement mint. Build each transaction locally
   without a wallet. Compare all non-prerequisite calldata against protocol ABIs and the safe SDK
   encoder surface, then prove the high-level SDK can be removed from the broadcast boundary without
   changing royalty or LAP behavior.
3. **Gate B — reverted policy.** Keep `reverted` terminal in v1. Any new generation is manual,
   explicitly authorized, and has a new effect and plan identity outside the reconciler.
4. **Gate C — chain policy.** Approve finality depths and safe-tag-with-depth-fallback behavior for
   Aeneid and Story mainnet, plus the conservative capped gas policy, broadcast-age paging threshold,
   and audited manual same-nonce replacement runbook.
5. **Gate D — signed-byte storage.** V1 keeps raw signed transactions only in Durable Object storage;
   they are never copied to community shards or external object storage. Loss of authoritative DO
   state yields `reconciliation_required` from chain and nonce evidence, never fresh signing.
6. **Gate E — exclusive signer.** Inventory every path and operational script that can use the
   settlement signer, prohibit direct signing outside the wallet-scoped coordinator, and decide the
   rotation plan before canary. Prefer a fresh coordinator-exclusive signer unless clean exclusive
   ownership of the current signer is proven.
7. Approve an abandoned-nonce repair before coordinator integration: either atomically reassign a
   reserved-but-unsigned nonce to the next runnable step while preserving audit identity, or consume
   it with a separately journaled zero-value self-transaction. Test cancellation, terminal
   configuration failure, rights-hold freezes, coordinator restart, and concurrent admission so a
   reserved unsigned nonce cannot wedge the wallet indefinitely.
8. Scope and verify the web `settlement_pending` checkout/polling experience before production
   admission.
9. Review the state machine and crash tests specifically for double-pay and nonce-gap risk.
10. Land Fix 2 before authorizing the Fix 3 sweeper.
