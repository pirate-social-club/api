# M1 decision: Story mainnet catalog scope

Status: unresolved. Unresolved owner means **no mainnet catalog work**.

Related plan: `../story-mainnet-pricing-treasury-design.md`

## Decision requested

Choose which Pirate assets may enter the Story-mainnet real-money pipeline.

This decision cannot be inferred from a chain ID, deployment environment, or existing Aeneid
registration. Aeneid IP IDs, vaults, royalty-token allocations, license state, and lineage do not
become mainnet state.

## Options

### A. Mainnet-forward-only — recommended for the first canary

Declare a cutover. Only assets newly registered under the approved Story-mainnet path are eligible
for real-money sales.

**Chosen limitation:** the entire existing Aeneid catalog is unsellable on the real-money path until
a separate, explicitly approved migration project completes. Initial real-money inventory is empty
and grows only from new mainnet registrations. The canary uses a freshly created mainnet asset.

- Advantages: smallest rights/cost/lineage surface, clear provenance, simplest rollback.
- Costs: split testnet/mainnet catalog semantics; existing songs and derivative videos remain
  testnet-only even after M0 says `go`.
- Reversibility: a later migration can add eligible historical assets; no mainnet records need to be
  rewritten.

### B. Migrate an approved eligible catalog snapshot

Create a separate resumable, lineage-ordered migration project.

- Parents/license terms before children; cycles and missing/excluded parents block descendants.
- Persist every registration transaction before broadcast and reconcile receipts/finality.
- Preserve Aeneid provenance and create distinct mainnet mappings; never relabel source IDs.
- Verify mainnet vault supply, collaborator balances, terms, lineage, and commerce readiness.
- Resolve cost ceiling, snapshot/cutover, rights holds, failures, and user-visible state.
- Reference compatible third-party-owned parents already registered on mainnet; never clone,
  re-register, or claim ownership of them.

- Advantages: eligible existing inventory can eventually sell for real money.
- Costs: materially larger engineering, registration spend, rights review, and operational risk.
- Reversibility: registrations are on-chain and generally not reversible; commerce eligibility can
  be disabled, but migration mistakes cannot be treated like database rollbacks.

### C. Hybrid/manual allowlist

Migrate selected assets case by case while new assets use the mainnet-forward path.

Not recommended for the first canary unless product has a named must-launch asset. It still requires
the migration journal and lineage/rights controls from option B; an allowlist is not permission to
perform ad hoc registrations.

## Required owner inputs

- Product/catalog owner:
- Rights/legal owner:
- Treasury owner for registration budget:
- Chosen option: A / B / C
- Cutover date and timezone:
- Eligible community/asset classes:
- User-visible network/eligibility language:
- Treatment of existing listings and pending quotes:
- Maximum migration asset count and spend, if B/C:
- Third-party parent verification owner, if B/C:
- Rollback/disable authority:

Any blank owner or ambiguous eligible population is a no-go for migration.

## Engineering consequences

For option A:

- build explicit chain-aware eligibility and UI labels;
- reject Aeneid-only assets from mainnet quotes/listings;
- create the canary song/video lineage fresh on mainnet;
- retain Aeneid for testnet history without presenting it as real-money registration;
- defer historical migration into a new decision and budget.

For option B/C:

- produce a read-only dry inventory and dependency DAG first;
- report eligible, blocked, third-party-parent, cyclic, and ambiguous assets plus estimated cost;
- approve that report before any broadcast;
- use a migration coordinator with journal, nonce ownership, exact replay, finality, verification,
  alerts, and manual disposition;
- keep commerce admission off until each asset is fully verified.

## Recommendation

Choose option A for the first real-money canary. It minimizes irreversible work and separates proof
of the purchase/royalty/delivery mechanism from the much larger historical migration problem. This
recommendation is valid only if the owner explicitly accepts that `go` unlocks no existing library.

## Decision record

- Decision: **unresolved — no catalog work by default**
- Chosen option: A / B / C
- Accountable product approver:
- Rights/legal approver:
- Treasury approver, if B/C:
- Approved scope/evidence attachment:
- Decision date:
- Review/expiry date:
- Notes:
