# M2 spike: Story mainnet IP/USD rate-source evidence

Status: proposed read-only spike. This document authorizes no trade, approval, signature,
transaction, secret change, mainnet quote, or settlement admission.

Related plan: `../story-mainnet-pricing-treasury-design.md`

## Question

Is there a sufficiently fresh, liquid, manipulation-resistant, and operationally usable source for
pricing Story mainnet IP obligations in USD, with an independent sanity source and measurable
USDC-to-IP treasury replenishment cost?

The spike may conclude `no acceptable source`. Provider availability is not approval; Gate M2
remains unresolved until the evidence is reviewed and an accountable owner accepts the operational
dependency.

## Non-goals

- Do not select production slippage, margin, TTL, exposure, or reserve values.
- Do not acquire IP/WIP or spend USDC.
- Do not deploy contracts, create feeds, increase oracle cardinality, approve tokens, or touch pools.
- Do not store provider credentials or unrestricted raw payloads in the repository.
- Do not wire the result into quotes, coordinator admission, or Wrangler configuration.
- Do not infer M0 or M1 approval from technical feasibility.

## Candidate inventory

Inventory candidates from primary protocol/provider documentation and on-chain read-only discovery:

1. Story-mainnet native IP/USD oracle feeds.
2. On-chain IP/USDC or IP/stablecoin pools and their TWAP/oracle interfaces.
3. IP/native and native/USD composed routes, including compounded freshness/manipulation risk.
4. Off-chain institutional/market-data providers with authenticated observations and usage rights.
5. Independent exchange/venue observations suitable only as a sanity source.

For every candidate record exact chain, contract/feed/pool or market identifier, decimals, update
mechanism, heartbeat/TWAP window, venue, documentation URL/version, terms relevant to settlement,
and known outage/staleness behavior. Symbols alone are not identity.

## Read-only safety boundary

Allowed operations:

- official documentation retrieval;
- `eth_chainId`, `eth_call`, `eth_getBlockByNumber`, and log/block reads;
- provider HTTP GET/read APIs under existing approved credentials;
- public market/venue metadata and order-book/pool-state reads;
- local calculation and append-only evidence output containing no secrets.

Forbidden operations:

- `eth_sendRawTransaction`, signing, wallet connection, approvals, swaps, liquidity changes, or
  contract writes;
- faucet use, test transactions presented as mainnet liquidity evidence, or paid subscriptions;
- sampling through the settlement signer or contract-owner key;
- fallbacks that silently replace a missing observation with `$1 = 1 IP` or a cached value.

The collector transport must throw on every JSON-RPC write method. Tests assert the denylist before
any live read.

## Observation window

Run two stages:

### Stage A: feasibility sample

- Minimum duration: 24 hours.
- Cadence: no faster than provider terms allow; target 1-5 minutes.
- Purpose: reject unusable identities, unsupported history, stale feeds, broken decimals, missing
  liquidity, or sources that cannot be independently compared.

### Stage B: review sample

- Minimum duration: 14 consecutive days and at least one weekend.
- Preserve timestamps in UTC and block number/hash for on-chain samples.
- Record every scheduled sample, including failures; absence is evidence.
- Restart must append without rewriting earlier observations.
- Clock skew and duplicate provider observations are explicit fields, not silently normalized away.

Longer observation is required if the window contains no meaningful volatility, congestion, venue
outage, or liquidity variation. Fourteen quiet days do not prove tail behavior.

## Normalized sample

Each sample contains:

- source and source-version identifier;
- market/feed/pool identity and chain ID;
- observed and ingested timestamps;
- block number/hash for on-chain data;
- integer fixed-point `usd_micros_per_ip` and source decimals;
- bid, ask, mid, or oracle price classification;
- source heartbeat/update age;
- liquidity/depth fields available from the source;
- provider confidence/status fields where available;
- request/provider reference safe for audit;
- success or bounded failure code;
- raw-evidence digest and separately retained bounded fixture when licensing permits.

Floating point is prohibited in normalized calculations. Raw source precision is retained, then
converted with explicit integer rounding.

## Executable replenishment model

Reported IP/USD mid-price is not enough. For each approved candidate venue/route, calculate the
effective USDC cost to replenish the treasury at representative sizes without executing a trade.

Sizes must cover at least:

- one floor-price canary obligation;
- expected single-purchase p50/p95 obligation;
- proposed daily replenishment batch;
- proposed maximum exposure batch.

Include:

- bid/ask spread and direction (USDC -> IP);
- quoted price impact/depth or AMM curve result;
- venue/swap fees;
- Base-to-Story transfer/bridge route, fees, limits, delay, and trust assumptions if required;
- gas estimate from read-only simulation where supported;
- failed/partial route and minimum-received behavior;
- custody/venue withdrawal costs and timing;
- delay risk between USDC collection and IP availability.

If no executable, reviewable replenishment route exists, M2 fails even when a display price exists.

## Measurements

Report per source and source pair:

- sample success rate and longest outage;
- update age p50/p95/p99/max and heartbeat violations;
- price return distribution over quote-like windows;
- adverse movement p50/p95/p99/max over candidate quote TTLs;
- cross-source deviation p50/p95/p99/max;
- consecutive deviation duration above candidate circuit-breaker bands;
- liquidity/depth p50/min and replenishment-size coverage;
- executable replenishment premium over reported mid-price by size;
- frequency of zero, malformed, reverted, unsupported, or stale observations;
- block reorg/canonicality observations for on-chain sources;
- provider rate-limit and correction behavior.

Do not average contradictory sources. Flag disagreement and measure its duration.

## Acceptance questions

The review must answer yes, no, or unresolved:

1. Is there a primary source with unambiguous IP/USD identity and sufficient freshness?
2. Is there an independent sanity source that does not share the same failure/liquidity dependency?
3. Can both be queried under acceptable commercial and operational terms?
4. Is the source manipulation cost defensible relative to Pirate's maximum admitted exposure?
5. Does observable liquidity cover proposed replenishment sizes with bounded cost?
6. Can stale, divergent, or unavailable states be detected before admission?
7. Can evidence be retained without leaking credentials or violating provider terms?
8. Is there an executable USDC-to-IP replenishment route and accountable treasury owner?
9. Are outages/deviations compatible with a fail-closed product experience and refund SLA?
10. Is `no acceptable source` still the honest conclusion?

Any unresolved answer blocks M2 approval.

## Deliverables

1. Candidate inventory with primary-source citations and exact identities.
2. Read-only collector with write-method denial tests and deterministic normalization tests.
3. Bounded, non-secret Stage A fixtures and summary.
4. Append-only Stage B observation artifact in approved storage, plus a reproducible summary script.
5. Source comparison, outage, deviation, and manipulation/liquidity analysis.
6. Executable replenishment-cost table by obligation size.
7. Recommendation: approve candidate pair for policy design, extend observation, or reject M2.
8. Explicit list of facts still requiring M0 treasury/compliance ownership.

## Review gates after the spike

The spike does not approve production configuration. A successful result only permits a separate M3
policy proposal defining quote TTL, max observation age, source-deviation breaker, protection band,
replenishment-cost margin, floor price, reserves, exposure limits, and refund behavior. Those values
must be replayed against the captured evidence before review.

Shadow pricing comes after the observation/snapshot engine is built and remains non-authoritative:
it computes and records hypothetical quote/admission values against testnet purchases without
changing buyer amounts, WIP settlement amounts, eligibility, or delivery.
