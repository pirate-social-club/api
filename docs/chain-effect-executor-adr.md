# Chain effect executor direction

Status: accepted direction; booking/reward nonce domains piloted, broader signer inventory reconciliation pending.

## Decision

All hosted on-chain writes must eventually pass through a durable executor keyed by the EVM nonce domain:

```text
chain_id + normalized signer_address
```

Purpose names do not define a safe shard. Registration, settlement, payout, or entitlement operations may use separate executors only when they use separate signer addresses on that chain.

The executor is a durable inbox and alarm-driven drain loop. A Durable Object is a convenient home for that state, but routing RPC calls through one object does not itself provide single-flight execution: requests can interleave while awaiting chain or signing-provider I/O.

Callers submit an immutable operation and receive an operation identifier. They do not await the complete chain workflow. Local sagas converge later from executor state and observed receipts.

## Existing implementation boundary

`OperatorSigningCoordinatorDO` now pilots this model for booking and reward transfers and provides:

- deterministic routing by operator address and chain;
- immutable idempotency fields;
- durable nonce allocation;
- precomputed signed transaction hashes;
- compare-and-swap transitions and transaction-liveness reconciliation.
- a durable SQLite inbox with schema migrations and bounded retry metadata;
- alarm-owned nonce allocation, signing, broadcast, and receipt reconciliation.

Its request methods only validate, persist, read, and schedule work; external signer and chain I/O is owned by the alarm. Ordinary repeated `settle` calls preserve alarm backoff, while explicit `confirm`/`reconcile` calls request immediate convergence. The signing claim and version CAS remain defense in depth against event interleaving.

This is still a pilot rather than the final universal executor contract. Existing purpose-prefixed object names are preserved to avoid orphaning durable state. Runtime configuration currently rejects a shared booking/reward signer address, so each accepted purpose shard is also one nonce domain. Any future relaxation of that guard requires a wallet-only object-name migration first.

The in-flight community-job fencing and Story-registration effect work remains required. It protects at-least-once callers, migration windows, accidental bypass paths, and business-level uniqueness that the executor does not replace.

## Signer inventory

This inventory records code paths, not intended future policy. Addresses are resolved from hosted configuration and must be verified against `core/docs/operators/signer-families.md` before executor rollout.

| Nonce domain family | Current backend | Write paths | Required action |
| --- | --- | --- | --- |
| Story operator | Direct key validated against `STORY_OPERATOR_PKP_ADDRESS` | royalty registration; Story publish; presentation and asset publish operations | Reconcile direct-key runtime with PKP-only policy; route every write for the resolved address through one executor. |
| Story settlement | Direct key validated against `MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS` | royalty payment; parent-vault transfer; entitlement mint | Reconcile direct-key runtime with PKP-only policy. Journal each subtransaction independently. |
| Story CDR writer | Direct key validated against `STORY_CDR_WRITER_PKP_ADDRESS` | CDR allocation and write; locked asset and replay delivery | Treat allocate and write as separate effects in the same nonce domain. |
| Story entitlement class configurer | Direct key with expected-address validation | entitlement class configuration during Story publish | Inventory whether it shares an address with another Story family before assigning an executor. |
| Story contract owner/runtime funder | Direct keys | authorization, grants, and signer funding | Keep operational owner actions separate from product workflows, but shard by actual address if automated. |
| Booking settlement | Direct key | Base USDC booking payout and refund | Pilot migrated to inbox submission and alarm convergence. Preserve signer-domain guard during rollout. |
| Reward settlement | Direct key | Base USDC reward cashout | Pilot migrated to inbox submission and alarm convergence; runtime requires an address distinct from booking. |
| Checkout/charity operators | Direct keys | checkout funding and Endaoment payout flows | Complete method-level inventory before executor implementation. |

Off-chain signatures such as short-lived access proofs do not consume an EVM nonce and are outside the transaction drain, even if they use a related signer family.

## Durable model

The executor stores immutable operations and per-subtransaction effects.

```text
operation: accepted -> executing -> completed
                              +-> failed
                              +-> needs_review

effect: intended -> prepared -> broadcasting -> broadcast -> confirmed
                                      |             |          +-> reverted
                                      +-------------+-> unknown
```

Each effect records the chain, signer address, nonce, signed transaction, expected hash, actual hash, receipt, replacement history, immutable call data hash, and business idempotency key. Persist preparation before broadcast. An alarm processes at most one active operation per nonce domain and reschedules itself while runnable or reconcilable work remains.

An `unknown` outcome never authorizes a fresh effect. Reconciliation first checks the expected hash, receipt, pending/latest signer nonce, and provider history. Contract-level idempotency remains preferred for ruinous effects.

## Saga and projection boundary

The executor owns transaction execution facts. Domain sagas own desired business state. D1 effect tables retain global business constraints and mirror executor outcomes. Projection convergence must remain safe after saga completion so terminal-but-drifted projections can be repaired.

No saga may infer that a failed RPC means a transaction did not broadcast. Only a pre-broadcast state or reconciled chain evidence permits another attempt.

## Funding receipt direction

Buyer funding should move toward a global observed-receipt ledger. A future payment-intent contract must use a domain-separated quote reference and a signed exact intent binding buyer, chain, token, amount, recipient, and expiry. A bare caller-supplied quote identifier is insufficient because it permits quote squatting and dust-payment griefing.

`MarketplaceSettlementV1` already demonstrates contract-level `purchaseRef` consumption for Story settlement. The funding design must explicitly decide whether to extend that boundary or deploy a separate payment-intent router. Either choice must keep reorg-aware receipt states and does not remove journaling for unrelated registration or royalty effects.

## Rollout gates

1. Reconcile signer-family documentation with deployed signer backends and addresses.
2. Complete method-level inventory for every automated signer.
3. Preserve current job fencing and business idempotency constraints.
4. Pilot one resolved `(chain_id, signer_address)` domain. **Done for booking/reward domains.**
5. Prove concurrent submissions allocate unique ordered nonces. **Covered by isolated workerd tests for the pilot.**
6. Prove alarm retry, eviction, broadcast-timeout, nonce-replacement, revert, and post-broadcast crash recovery.
7. Cut callers over only after direct signing outside the executor is rejected or alertable.
