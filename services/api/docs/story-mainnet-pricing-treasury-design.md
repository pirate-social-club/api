# Story mainnet pricing, treasury, and launch gates

Status: design proposal; no mainnet registration, funding, admission, or buyer payment is authorized
by this document.

## Decision summary

The current purchase path is a testnet system: buyers fund with Base Sepolia USDC and the platform
settles royalties on Story Aeneid. Its nominal conversion of one US dollar to one IP is test-only.
Moving the sold-video -> Story-song royalty pipeline to real money is a product, treasury,
compliance, catalog-migration, and operations project, not a chain-ID configuration change.

Before implementation begins, accountable owners must approve two blocking decisions:

1. **Real-money go/no-go.** Approve the custody, treasury, tax, royalty-accounting, compliance,
   incident-ownership, and maximum-loss posture for holding buyer USDC and spending platform IP.
2. **Catalog scope.** Choose either a lineage-ordered migration of the eligible existing catalog or
   a mainnet-forward-only launch. No engineer or deploy operator may infer this choice from config.

The first engineering design invariant is:

> Repricing is permitted before coordinator admission only. Admission durably freezes the price
> observation, effective rate, fresh-rate base WIP payment amount, protected maximum, expiry, and
> policy version into the immutable settlement plan. Pricing margin never increases the royalty WIP
> paid by the plan.

If the rate is stale, unavailable, outside the quote's allowed movement, or the treasury cannot
cover the admitted obligation and reserves, admission fails before any Story transaction is signed.
Once admitted, an exchange-rate change cannot mutate, cancel, or resize the plan.

## Scope

This document defines:

- the quote-to-admission FX risk window;
- rate-source requirements and failure behavior;
- quote expiry, slippage, and pricing-margin policy;
- immutable price snapshots and call-identity inputs;
- native IP, WIP, USDC, and gas treasury reserves;
- solvency admission and monitoring rules;
- catalog migration choices and required journal discipline;
- recovery tooling and adjacent money-path prerequisites;
- mainnet provisioning and canary gates.

It does not select a commercial rate provider, approve a mainnet fee policy, decide legal or tax
treatment, authorize catalog migration, or enable mainnet traffic.

## Current-state boundary

`story-settlement-coordinator-policy-v1.md` records the current state:

- Story settlement uses Aeneid chain 1315;
- buyer checkout uses Base Sepolia chain 84532 and test USDC;
- WIP settlement uses the nominal rule `$1.00 = 1 IP`;
- Story mainnet chain 1514 has no approved fee/finality policy;
- Aeneid IP IDs, vaults, royalty-token allocations, and lineage do not carry to mainnet.

The coordinator's transaction safety properties are already the correct shape for mainnet:
persist-before-broadcast, immutable calls, exclusive nonce ownership, exact-byte replay, finality,
and delivery-last. This proposal preserves those properties and moves pricing uncertainty entirely
ahead of plan admission.

## Safety and economic invariants

These are mainnet merge and admission gates.

1. **No nominal conversion.** Chain 1514 rejects the Aeneid `$1 = 1 IP` policy.
2. **USD is the product unit.** Buyer price, fees, accounting, refunds, and limits remain integer
   USDC micros/cents. IP/WIP is a separately calculated platform obligation.
3. **One immutable snapshot.** A coordinator plan references exactly one admitted price snapshot.
   Its fresh-rate base WIP payment amount and policy version cannot change after admission.
4. **No stale admission.** An observation older than its policy maximum age cannot admit a plan.
5. **No silent fallback.** Provider failure, disagreement, unsupported market, or invalid data fails
   closed. Mainnet must never fall back to `$1 = 1 IP`, the last known price beyond its TTL, or an
   operator-entered value without a separately authorized emergency policy.
6. **No unbounded subsidy.** The platform margin and rate bounds cap normal FX loss. A sale that
   violates the bound is rejected before admission.
7. **Margin is not royalty principal.** Margin affects the buyer's USD price/protection and the
   maximum WIP the quote permits at admission. The plan wraps and pays only the fresh admission-rate
   `base_wip_atomic`. It never wraps or pays `quote.max_wip_atomic`. Margin therefore cannot
   overpay royalty recipients or manufacture routine surplus WIP.
8. **Buyer finality precedes IP spend.** No native IP is wrapped, approved, or otherwise committed
   until the globally claimed Base-mainnet USDC receipt reaches the approved finality policy and its
   receipt block remains canonical. An inclusion-level receipt is insufficient.
9. **Solvency before signing.** Admission reserves the full immutable wrap amount, capped gas for
   every step, and configured safety buffer. Existing unreserved WIP may be counted only under a
   reviewed committed-obligation model; v1 should retain unconditional native-IP wrap semantics.
10. **Reservations are global.** Coverage is computed across all communities sharing the mainnet
   coordinator signer, not per shard.
11. **Buyer funding is globally unique.** Every USDC rail must claim its canonical receipt before
   real-money launch.
12. **Refunds are journaled value movement.** A platform-to-buyer USDC refund uses a dedicated
    persist-before-broadcast executor keyed by the canonical funding-receipt identity. It cannot be
    implemented as an ordinary retryable SDK/wallet call.
13. **Money moved without delivery pages.** Any failed/reverted plan, replacement, nonce gap,
    insolvency, stale price feed, or confirmed payment lacking delivery creates durable alert
    evidence.
14. **Recovery is executable.** Mainnet admission remains disabled until nonce repair and audited
    same-nonce fee replacement can be invoked through scoped, logged operator actions on staging.
15. **No mutable catalog identity.** Mainnet assets, lineage, license terms, vaults, allocations,
    and source-chain provenance are durably mapped; Aeneid IDs are never relabeled as mainnet IDs.
16. **Required screening precedes admission.** If Gate M0 requires sanctions or other identity
    screening, the approved result and policy version are an admission preflight. Post-settlement
    reporting cannot substitute for a required preflight.

## Quote-to-admission lifecycle

### Phase 1: rate observation

A pricing service obtains a versioned IP/USD observation and validates it under an approved policy.
The normalized observation contains:

- `rate_snapshot_id`;
- `rate_policy_version` and `provider_version`;
- base asset `IP`, quote asset `USD`;
- integer fixed-point `usd_micros_per_ip`;
- observation timestamp and ingestion timestamp;
- provider/source identifiers and market identifiers;
- provider confidence, liquidity, or deviation evidence when available;
- cryptographic payload/reference when the source supports it;
- validation result and bounded rejection code.

Floating point is prohibited. All conversion uses documented integer rounding. Platform obligations
round up so collaborators are never underpaid by truncation; buyer USDC amounts remain exact quote
micros.

### Phase 2: buyer quote

The buyer quote stores:

- USD price and exact USDC atomic amount;
- `rate_snapshot_id` and observed IP/USD rate;
- margin and reserve policy versions;
- effective protected rate after margin, used only to derive the admission ceiling;
- quoted maximum WIP amount;
- maximum permitted rate movement at admission;
- quote creation and hard expiry times;
- checkout chain, canonical USDC token, recipient, and buyer wallet.

The quote response may display the USD price and expiry. Internal margin and treasury thresholds do
not need to expose sensitive balances, but the persisted quote must remain auditable.

### Phase 3: buyer funding

Buyer funding is verified and globally claimed using chain, token, transaction hash, log index,
sender, recipient, amount, quote identity, consumer rail, and finality evidence. Receipt claiming is
not an FX lock. The claim may be recorded while finality is pending, but coordinator admission and
all IP spending remain prohibited until the receipt reaches the approved Base-mainnet finality rule
and its block hash is canonical. A confirmed USDC payment does not authorize settlement when the
quote or rate policy has expired.

Product policy must decide the buyer outcome when funding arrives too late or admission rejects for
rate/solvency reasons. The only acceptable v1 choices are a refund executed by the dedicated durable
refund coordinator defined below or an explicit `refund_review` workflow with paging and bounded
SLA. Silently retaining funds or asking the buyer to pay again is prohibited.

### Phase 4: admission revalidation

Immediately before coordinator admission:

1. verify the quote and funding claim are canonical and unconsumed by another rail;
2. prove the funding receipt has reached approved Base-mainnet finality and remains canonical;
3. run every screening preflight required by Gate M0 and persist its policy/result reference;
4. verify quote and original rate snapshot have not expired;
5. obtain a fresh observation under the same approved policy;
6. compute the fresh admission-rate `base_wip_atomic` using round-up semantics;
7. compare that amount with the quote's protected maximum and max-slippage rule;
8. reject if `base_wip_atomic` exceeds `quote.max_wip_atomic`;
9. atomically reserve exactly `base_wip_atomic`, capped gas, and operational buffer against global
   obligations;
10. persist the admitted price snapshot and reservation;
11. derive the settlement request fingerprint and coordinator call identities from that snapshot;
12. admit exactly once.

The buyer is never charged additional USDC after funding. If the protected quote cannot admit, the
system follows the approved refund policy.

### Phase 5: immutable settlement

After admission, the coordinator wraps and pays exactly the frozen fresh-rate `base_wip_atomic`. It
does not wrap the quote's protected maximum, query a price provider, revise margin, consume a newer
snapshot, or resize calls during reconciliation. Eviction, RPC outage, delayed finality, fee
replacement, and exact-byte replay preserve the admitted amount.

## Durable USDC refund coordinator

A refund is a new value-moving rail, not a database status update. It has the same ambiguous-send,
crash, nonce, replacement, and double-payment risks as royalty settlement. Mainnet launch therefore
requires a dedicated wallet-scoped Base refund coordinator or an equivalently reviewed executor.

The refund identity is derived from:

- canonical funding-receipt identity `(chain, token, tx_hash, log_index)`;
- funding claim/consumer identity and buyer wallet;
- original received USDC amount;
- refund reason and refund-policy version;
- refund generation, where any later generation requires explicit operator authorization.

Its merge-blocking invariants are:

1. One canonical funding receipt can have at most one active/successful refund generation.
2. Refund eligibility and exact amount are persisted before nonce allocation or signing.
3. Exact signed bytes, nonce, transaction hash, token, recipient, and amount are committed before
   broadcast.
4. Ambiguous broadcast is reconciled from transaction, receipt, and nonce evidence; it never creates
   a fresh transfer.
5. Recovery re-broadcasts only identical signed bytes unless an audited same-nonce fee-replacement
   state machine records every candidate hash.
6. Buyer, token, and amount cannot be operator-edited after preparation.
7. A refund reaches `confirmed` only after approved Base-mainnet finality and canonical block-hash
   verification.
8. Purchase/refund-review state is finalized from confirmed coordinator evidence, not the HTTP
   response to broadcast.
9. Refund failure, replacement, age, or money-moved-without-local-finalization pages through the
   durable alert sink.

The refund journal stores plan/step identity, funding receipt reference, signer, nonce, immutable
ERC-20 transfer call, signed bytes, hashes, receipt/block identity, finality, attempts, and bounded
failure codes. Business records mirror bounded evidence and omit signed bytes. The refund signer
must have exclusive nonce ownership; sharing it with an uncoordinated checkout or treasury script is
prohibited.

Required refund tests include crash injection before/after persist, sign, broadcast, receipt, and
local finalization; concurrent refund requests for one receipt; replay across communities/rails;
absent hash with used/unused nonce; reverted transfer; reorg before finality; recipient/amount
conflict; and confirmed chain refund with missing local state. An operator cannot improvise a manual
USDC send and then mark the journal complete.

## Rate-source decision

No provider is approved by this document. A dedicated evidence spike must determine whether a
liquid, manipulation-resistant IP/USD mainnet market and usable oracle exist. The spike must use
primary provider/protocol documentation and read-only observations over a representative window.
The bounded procedure and required deliverables are specified in
`spikes/story-mainnet-ip-usd-rate-source.md`.

### Option A: on-chain oracle

Potential advantages:

- independently readable and timestamped on chain;
- deterministic verification at admission;
- smaller dependency on private provider credentials.

Required evidence:

- deployed Story-mainnet feed or defensible cross-chain composition;
- update cadence, heartbeat, decimals, deviation threshold, and stale-data semantics;
- sufficient market liquidity and manipulation resistance;
- behavior during sequencer/RPC/oracle outages;
- historical deviation from executable IP liquidity.

A feed merely existing is insufficient. If it is thin, stale, or economically manipulable relative
to expected purchase size, it cannot be the sole source.

### Option B: off-chain market-data provider

Potential advantages:

- broader venue coverage and volume-weighted data;
- operational SLAs and explicit confidence fields may be available.

Required controls:

- authenticated responses and provider request IDs;
- bounded caching and strict TTL;
- at least one independent comparison source;
- circuit breaker on deviation or missing venues;
- retained normalized evidence without retaining provider secrets;
- outage, rate-limit, correction, and symbol-remapping behavior;
- commercial terms allowing settlement use.

### Option C: executable venue/TWAP

Potential advantages:

- price is tied to available liquidity rather than a reporting feed;
- TWAP can reduce single-block manipulation.

Required controls:

- approved venue and pool addresses;
- minimum liquidity and maximum trade/obligation relative to depth;
- TWAP window and observation-cardinality guarantees;
- manipulation and liquidity-withdrawal analysis;
- independent sanity bound.

### Recommended evaluation shape

Evaluate a primary source plus an independent sanity source. Reject on excessive deviation; do not
average contradictory feeds into apparent certainty. Provider selection requires measured
freshness, deviation, liquidity, and outage evidence plus a documented owner. Until that decision is
approved, chain 1514 quote and admission code must remain disabled.

## Slippage, expiry, and margin policy

The policy is versioned and immutable for every quote and plan. It includes:

- quote TTL;
- maximum observation age at quote and admission;
- maximum adverse IP/USD movement from quote to admission;
- pricing margin/buffer in basis points;
- minimum and maximum WIP per purchase;
- minimum USD floor price;
- rounding mode and fixed-point scale;
- provider-deviation circuit breaker;
- USDC-to-IP acquisition venue, fees, spread, slippage, bridging/transfer costs, and treasury
  replenishment cadence;
- emergency-disable behavior.

Illustrative formulas, not approved values:

```text
quote_base_wip_atomic = ceil(usd_micros * 10^18 / quoted_usd_micros_per_ip)
quote.max_wip_atomic = ceil(quote_base_wip_atomic * (10_000 + protection_bps) / 10_000)
admission_base_wip_atomic = ceil(usd_micros * 10^18 / fresh_usd_micros_per_ip)
admit only when admission_base_wip_atomic <= quote.max_wip_atomic
plan.wrap_and_pay = admission_base_wip_atomic
```

`quote.max_wip_atomic` is a rejection ceiling, not royalty principal and not a wrap amount. The plan
never pays the difference between the ceiling and the fresh base amount.

Pricing margin is not a substitute for a slippage cap or treasury reserve. It must cover both the
quote-to-admission FX window and the platform's actual USDC-to-IP treasury-replenishment round trip:
venue fees, bid/ask spread, price impact, transfer/bridge costs where applicable, gas, failed or
partial acquisition overhead, and the delay between collecting USDC and replenishing IP. The cap
rejects abnormal movement; margin prices expected costs. Policy values require replay against
observed mainnet price/liquidity history, executable acquisition sizes, and replenishment cadence
before approval.

## Durable data model

Use additive control-plane records; community shards mirror only bounded business evidence.

### Rate observations

Store normalized rate, source/provider version, observed/ingested time, expiry, evidence reference,
validation state, and bounded rejection reason. Do not store credentials or unrestricted raw
provider payloads.

### Quote pricing snapshot

Store USD/USDC amount, observation reference, effective rate, replenishment-cost margin,
protection/slippage cap, maximum WIP ceiling, expiry, policy version, and deterministic fingerprint.

### Admission snapshot

Store the quote fingerprint, fresh observation, computed `base_wip_atomic`, quoted maximum WIP
ceiling, movement calculation, reservation identity, treasury-policy version, admitted timestamp,
and coordinator plan reference. The admission snapshot is append-only after it is linked to a plan.

### Treasury reservations

Store one global reservation per admitted plan with native wrap obligation, gas reserve, safety
buffer, state, and release/consumption evidence. Reservation writes and admission must be atomic from
the perspective of the wallet-scoped authority. A shard-local balance check is insufficient.

The coordinator request fingerprint and royalty-payment call identity include the admission
snapshot fingerprint and exact WIP amount. A retry with a different snapshot is a conflict, never an
update.

## Treasury and solvency model

The mainnet treasury holds real assets and needs named ownership, limits, and reconciliation.

### Balances and obligations

Track separately:

- native IP available for unconditional wraps;
- WIP surplus created by terminated or partially completed plans;
- native IP reserved by admitted but unwrapped plans;
- WIP already wrapped and committed to incomplete plans;
- maximum gas obligation for every nonterminal step;
- confirmed buyer USDC held pending completion or refund;
- accrued platform margin and withdrawable surplus;
- refund liabilities and incident reserves.

Do not count the same native IP/WIP twice. WIP already committed to one immutable plan is not
available to another. V1 retains the coordinator's unconditional full-amount wrap per plan; any
future reuse of surplus WIP requires a separately reviewed committed-spend ledger and new planning
policy version.

### Admission condition

Admission succeeds only when, after adding the new plan:

```text
available_native_ip
  >= reserved_wrap_ip
   + reserved_max_gas_ip
   + operational_buffer_ip
   + new_plan_wrap_ip
   + new_plan_max_gas_ip
```

The policy also enforces per-purchase, daily, and aggregate USD/IP exposure limits. Balance reads
alone are not authoritative; reservations bridge the time between admission and on-chain spend.

### Replenishment and withdrawal

- Funding uses a documented treasury source and dual-reviewed transfer procedure.
- Replenishment records the USDC spent, IP acquired, venue/route, fees, spread/impact, transaction
  evidence, and realized effective rate so Gate M3 assumptions can be reconciled against reality.
- Low-balance alerts fire before admission capacity reaches zero.
- Admission fails closed at the hard reserve floor.
- Withdrawals require zero impact on reserved obligations and refund liabilities.
- Surplus WIP is reconciled and alerted; it is not automatically swept or reused.
- Every treasury transfer records authorization, transaction hash, asset, amount, source,
  destination, and resulting public balance.

### Monitoring

Extend the existing wallet watchdog with:

- available, reserved, and projected native IP;
- committed and surplus WIP;
- pending USD obligation valued at both admission and current rates;
- coverage ratio and remaining admission capacity;
- oldest funded-but-unadmitted purchase;
- stale or divergent rate-source state;
- refund-review age;
- plans where money moved but delivery is absent.

Alerts require durable delivery evidence. Mainnet admission is disabled if the rate-source monitor,
treasury monitor, failed-plan alert, or delivery-evidence sink is unhealthy.

## Catalog-scope decision

### Option 1: mainnet-forward-only

Only assets created after a declared cutover register on Story mainnet. Aeneid history remains
testnet history and is never sold as mainnet-registered inventory.

Advantages: smaller launch scope, no historical lineage migration, lower registration cost, easier
rollback. Costs: split catalog semantics, older songs/videos cannot use the mainnet sale path unless
explicitly migrated later, and UI/API must display network eligibility clearly.

### Option 2: migrate eligible catalog

Re-register an approved snapshot of existing assets on mainnet.

This requires a resumable migration journal with:

- immutable source asset/version and Aeneid provenance;
- eligibility and rights-hold snapshot;
- topological ordering: parents and license terms before derivatives;
- mainnet registration, vault, license, lineage, and allocation transaction identities;
- persist-before-broadcast and receipt/finality reconciliation;
- Aeneid-to-mainnet mapping without overwriting source IDs;
- idempotent restart and manual disposition for ambiguous/reverted work;
- cost estimate, budget, rate limits, and migration freeze/cutover rules;
- post-registration vault/royalty-token verification.

Derivatives whose parent is excluded cannot be silently flattened or registered with different
lineage. They remain ineligible or require a separately approved rights decision.

Before scheduling any parent registration, the migration must resolve whether the canonical parent
already exists on Story mainnet and who controls it. A parent already registered and owned by a
third party is referenced through its existing mainnet IP ID and compatible license terms; Pirate
must not re-register, clone, or claim ownership of it. Incompatible/missing terms, ambiguous
identity, or inability to prove the relationship blocks the derivative for rights review. The
migration journal records the external parent reference and verification evidence without treating
the parent as a Pirate-owned migration result.

### Decision record

The approved decision must name the eligible population, cutover date, user-visible semantics,
cost ceiling, accountable product/legal owner, and rollback posture. Until recorded, catalog
migration code and mainnet registration are prohibited.

## Recovery tooling gate

Before a mainnet canary, staging must prove executable, scoped actions for:

1. **Abandoned nonce repair:** request the coordinator's already-designed, journaled zero-value
   self-transaction with immutable operator identity, authorization reference, and reason. The API
   route and coordinator RPC exist; the remaining gate is an audited staging-chain drill and its
   durable evidence.
2. **Manual fee replacement:** freeze admission; verify the original transaction is pending and the
   nonce unconfirmed; create a policy-bounded same-nonce candidate with identical target, value,
   calldata, and call identity; persist candidate bytes/hash before broadcast; retain every candidate
   hash; reconcile all hashes to one terminal result.

The fee-replacement action is not a generic arbitrary-transaction endpoint. It cannot edit business
calls, change value, skip dependencies, or operate without an active incident and reviewed cap.

Both actions require route tests, coordinator fault injection, staging-chain execution, durable
audit events, alert evidence, and runbooks that an operator other than the author can execute.
Admin-key improvisation is not an accepted mainnet recovery mechanism.

## Adjacent real-money prerequisites

These defects are launch-blocking even though they are independent of FX:

- Extend the global canonical funding-receipt claim to handle, profile, and public-name rails so one
  USDC receipt cannot fund two consumers across rails.
- Delete or make retry-safe the currently unwired `executeSongPurchase` helper before it gains a
  caller; no retry may create a second buyer funding transfer.
- Decide and implement late-funding/refund handling before accepting Base-mainnet USDC.
- Confirm every funding rail uses canonical Base-mainnet USDC, global receipt identity, sufficient
  finality, reorg handling, and durable refund/review state.

## Mainnet provisioning

Provisioning is a reviewed ceremony, not ordinary environment editing.

- Approve Base mainnet checkout chain, canonical USDC, confirmation/reorg policy, and custody wallet.
- Create a fresh coordinator-exclusive Story mainnet signer under a new secret name.
- Derive and independently verify its address without printing the key.
- Grant only required roles, including entitlement minter, on the mainnet contracts.
- Verify the minter role at admission and alert on terminal mint failure because roles remain
  revocable after admission.
- Fund native IP under the approved treasury procedure and reserve model.
- Add native IP/WIP balances and obligations to the watchdog before admission.
- Inventory and prohibit every non-coordinator signing path for that signer.
- Approve mainnet contract addresses, code hashes/owners, ABIs, royalty-vault behavior, and license
  configuration.
- Repeat the mainnet gas/finality observation over an approved window; choose new versioned values.
  Aeneid values and the unapproved starting point in the v1 policy cannot be copied automatically.
- Use separate mainnet policy, signer-domain, catalog-mapping, and admission flags. A single chain ID
  change must be insufficient to enable money movement.

Key creation and rotation follow Infisical source-of-truth and secret-safety procedures. No private
key appears in commands, logs, tickets, PRs, temporary plaintext files, or responses.

## Business go/no-go record

Before engineering implementation beyond read-only spikes, accountable owners approve:

- buyer and platform terms for USDC collection, delayed fulfillment, refund, and failed settlement;
- custody ownership for USDC, IP, WIP, contract-owner keys, and coordinator signer;
- tax/accounting treatment for platform revenue and collaborator/parent royalty flows;
- applicable identity, sanctions, consumer, money-transmission, and reporting obligations;
- treasury capital, maximum daily/aggregate exposure, and acceptable loss;
- incident response ownership and buyer-support SLA;
- launch geography/community/catalog scope;
- explicit authority to execute a floor-price real-money canary.

This document records engineering controls, not legal advice. An unresolved owner or control is a
`no-go`, not an engineering assumption.

If the approved M0 policy requires sanctions or identity screening, it must specify subjects,
provider/evidence, freshness, re-screening triggers, false-positive/manual-review behavior, and
policy version. Required screening runs before coordinator admission and before any refund to a
changed destination. A post-hoc report cannot cure IP already spent for an ineligible transaction.

## Rollout sequence

1. Approve the business go/no-go and catalog-scope decision records.
2. Run the read-only mainnet rate-source/liquidity evidence spike.
3. Approve the FX, slippage, margin, refund, and treasury policy versions.
4. Build the additive observation, quote-snapshot, admission-snapshot, reservation, and refund
   coordinator ledgers with pricing/admission disabled.
5. Staging-test the existing abandoned-nonce repair action and build plus staging-test audited fee
   replacement.
6. Close cross-rail funding replay and remove/fix `executeSongPurchase`.
7. Implement pricing and solvency admission behind an explicit mainnet-disabled gate; shadow it
   against testnet purchases without changing settlement amounts.
8. Provision and audit mainnet contracts, catalog policy, signer, minter role, treasury, watchdog,
   fee policy, finality policy, and alert sink.
9. If catalog migration is selected, run its journaled dry inventory, cost report, and then approved
   lineage-ordered migration with admission off.
10. Run a staging rehearsal of the complete operational ceremony and every recovery action.
11. Enable one explicitly allowlisted mainnet community and one floor-price asset for a capped
    canary; all other admission remains disabled.
12. Expand only after financial reconciliation, delivery, royalties, alerts, recovery, and buyer
    support evidence are reviewed and the next exposure cap is approved.

## Mainnet canary

The canary uses real Base-mainnet USDC and Story-mainnet IP, so it requires explicit spend authority.
It must be the minimum approved floor price and capped to one buyer, community, asset, and plan.

Verify:

- fresh rate observation and protected quote;
- globally claimed buyer funding receipt;
- finalized and canonical Base-mainnet funding receipt before any IP wrap;
- immutable admission snapshot and treasury reservation;
- wrap, approval, royalty payment, every parent transfer, and entitlement mint;
- finality and canonical block evidence;
- collaborator/parent vault outcomes;
- local entitlement and CDR delivery only after confirmation;
- treasury reservation consumption and USDC/IP accounting;
- durable alert delivery under a synthetic and one injected recoverable condition;
- pending-purchase web UX and no second funding request;
- refund/review behavior in a separate non-value or explicitly budgeted drill.

Run crash-matrix scenarios only within the approved canary budget. Do not induce a known terminal
revert with real value merely to prove paging; use prebroadcast faults, controlled eviction, exact
replay, and staging evidence for destructive cases.

Stop expansion on any duplicate claim, pricing mismatch, stale observation, reservation mismatch,
unexpected signer transaction, nonce gap, revert/replacement, missing alert, accounting difference,
or money-moved-without-delivery state. Rollback disables new admission while existing plans continue
reconciliation.

## Required design and implementation tests

### Pricing

- fixed-point conversion and round-up behavior at boundaries;
- stale, missing, malformed, zero, overflow, and divergent observations;
- quote expiry and adverse/favorable movement;
- margin and max-WIP enforcement;
- provider outage never invokes nominal fallback;
- policy-version conflicts and immutable snapshot replay.

### Concurrency and treasury

- concurrent admissions across communities cannot over-reserve one wallet;
- balance plus reservations never double-counts WIP/native IP;
- eviction between reservation and plan creation converges atomically or releases safely;
- terminal/prebroadcast, partial-wrap, confirmed-payment, and refund liabilities reconcile;
- withdrawals cannot consume reserved funds.

### Funding and refund

- one receipt cannot cross asset/handle/profile/public-name rails;
- retry never sends or claims a second buyer payment;
- late funding and admission rejection enter the approved refund path;
- reorged funding freezes admission/delivery and pages.
- no IP transaction is prepared before buyer-funding finality;
- refund persist-before-broadcast, exact replay, nonce fencing, and finality;
- concurrent refund requests for one receipt yield one transfer;
- confirmed refund with missing local finalization self-heals without another transfer.

### Catalog

- parent-before-child ordering, cycles, missing parents, excluded assets, and replay;
- mapping uniqueness across source/mainnet IDs;
- crash after every broadcast/storage boundary;
- vault supply/balance verification before commerce eligibility.

### Operations

- abandoned-nonce repair and fee replacement through scoped credentials;
- signer/minter-role preflight and post-admission revocation alert;
- rate, treasury, failed-plan, and delivery-evidence alerts reach the durable sink;
- drain-before-policy-rotation;
- single-community allowlist cannot expand through config ambiguity.

## Decision gates

Owner-ready decision records for the two non-engineering gates live in
`decisions/story-mainnet-m0-real-money-go-no-go.md` and
`decisions/story-mainnet-m1-catalog-scope.md`. Blank ownership or an unresolved record remains a
no-go.

1. **Gate M0 — business go/no-go:** unresolved.
2. **Gate M1 — catalog scope:** unresolved; choose mainnet-forward-only or journaled migration.
3. **Gate M2 — rate source:** unresolved; requires mainnet liquidity/freshness evidence.
4. **Gate M3 — economics:** unresolved; approve quote TTL, slippage, floor, exposure, refund policy,
   and margin covering both FX drift and the measured USDC-to-IP replenishment round trip.
5. **Gate M4 — recovery tools:** open overall; abandoned-nonce repair is staging-chain proven, while
   same-nonce replacement still requires an executable action and staging proof.
6. **Gate M5 — adjacent rails:** open; global cross-rail claim and retry-safe/deleted helper.
7. **Gate M6 — mainnet provisioning:** open; contracts, exclusive signer, minter role, treasury,
   watchdog, gas/finality policies, and catalog mapping.
8. **Gate M7 — rehearsal:** open; staging operational ceremony and recovery drills.
9. **Gate M8 — real-money canary:** prohibited until M0-M7 are approved with an explicit spend cap.

No gate is satisfied by merging this document.
