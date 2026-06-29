# Telegram TON Funding Design

Status: design note for `feature/ton-omniston-funding`.

## Decision

Keep Base USDC as the only canonical settlement receipt.

Telegram Wallet / TON funding is a source-acquisition path only. It can help a
Telegram user fund a spend intent without Privy, but an asset unlock must still
come from a verified Base USDC settlement receipt.

Do not make USDT-TON or any TON-side transfer a second canonical settlement
ledger without a separate financial proof review.

## Existing Invariant

The current settlement verifier accepts a funding receipt only when the Base USDC
transfer log matches:

- token: configured Base USDC token
- recipient: checkout operator / funding destination
- sender: `buyerAddress`
- amount: at least the expected quote amount
- chain: configured Base chain

The amount check is intentionally `>= expectedAmount`, not exact. That means a
route that over-delivers USDC can settle without exact-out routing. Refund/dust
handling is optional policy, not required for unlock correctness.

The sender check is the load-bearing constraint for bridged TON funding. A
TON-originating route will usually deliver Base USDC from a bridge or solver
address, not from the buyer's EVM address. A bridged receipt therefore cannot
pass the current direct-buyer verifier unchanged.

## What Is Already Wired

The branch already has the Telegram-side purchase shape:

- `spend_intents.telegram_user_id` can bind an order to a verified Telegram user.
- Mini App `init_data` verification gates Telegram confirmation routes.
- `expectedTonPayload(spend_intent_id)` provides the required per-order TON
  comment for the dev/test TON path and for any future provider that supports
  caller-supplied TON payloads.
- `ton_testnet_transfer` is explicitly a dev-only UX/state-machine simulation,
  not a canonical funding receipt.
- `omniston_ton` remains gated off because live settlement proof is not complete.

## Why "Watch TON And Unlock" Is Rejected

Watching a TON or USDT-TON transfer and unlocking directly would create a second
canonical settlement asset. That expands the proof surface to Jetton transfer
parsing, TON finality, treasury accounting, replay handling, refund policy, and
cross-ledger reconciliation.

That is a different architecture from this branch. The chosen architecture keeps
one canonical receipt model and treats TON as a funding source.

## Bridged Receipt Attribution Problem

A bridge/solver delivery has this shape:

1. Buyer signs a TON-side payment from Telegram Wallet.
2. The TON payment either carries Pirate's `expectedTonPayload(spend_intent_id)`
   or a provider-generated payload that Pirate cannot control.
3. A route swaps/bridges the value.
4. A bridge/solver sends Base USDC to the checkout operator.

The Base transfer alone is not enough to attribute the payment to a spend intent:

- `from` is the bridge/solver, not the buyer.
- `to` is the shared operator address.
- `value >= expectedAmount` is not unique across concurrent intents.

Therefore attribution must bind both legs:

- TON source leg, memo-bound mode: sender, recipient, amount, and exact comment
  = `expectedTonPayload(spend_intent_id)`.
- TON source leg, provider-generated-payload mode: sender, recipient, amount,
  and source tx hash can be verified on-chain, but the source tx does not
  self-identify the spend intent. The spend-intent binding then depends on the
  server-created route reference and its one-route-one-intent idempotency.
- Base delivery leg: token, recipient, chain, confirmed status, and
  `amount >= expectedAmount`.
- Route correlation: route/bridge evidence locates the Base delivery tx for this
  intent. The lookup rule is TON source tx -> bridge/route order reference ->
  Base USDC tx hash. The system must not discover bridged deliveries by scanning
  shared operator inbound transfers for recipient + amount.

This is a deliberate proof-model extension. It must not be implemented by simply
trusting `route_provider` or by relaxing the existing Base verifier globally.

Route/bridge evidence is correlation data only in memo-bound mode. It may tell
the verifier which on-chain transactions to inspect, but it never substitutes
for on-chain verification.

Provider-generated-payload mode has a materially weaker trust boundary: route
evidence is no longer only a locator, because it is also the off-chain link
between the source tx and the spend intent. Do not treat this as equivalent to
the memo-bound model. It can be acceptable only if some other on-chain
self-attribution exists, most likely a per-intent Base destination address, or
if the team explicitly accepts provider-trust-only attribution as a separate
financial policy decision.

Amount roles:

- Base delivery amount gates unlock. The Base USDC delivery must be at least the
  expected quote amount.
- TON source amount supports attribution, audit, and refund policy. It should
  verify the buyer funded the selected route, but it is not itself the settlement
  sufficiency gate.
- Do not require brittle equality between TON source value and post-fee Base
  output. Swap/bridge fees, route buffers, and over-delivery make equality the
  wrong invariant.

Per-intent Base destination addresses could make the Base leg self-attributing.
If the selected bridge cannot attach Pirate's exact TON memo, per-intent Base
destinations are likely required to keep an on-chain spend-intent binding. A
shared operator destination plus provider-generated TON payload leaves
attribution provider-trust-only; that is likely a no-go for the canonical
receipt invariant unless approved as a deliberate policy exception.

Bridge viability decision tree:

1. Can the bridge attach Pirate's exact TON memo/payload to the source tx?
   Memo-bound attribution is viable.
2. If not, can the bridge deliver to a Pirate-controlled per-intent Base
   destination address?
   Provider-generated payload attribution may be viable, with the Base delivery
   leg providing the on-chain spend-intent binding.
3. If neither is true, attribution depends on provider route evidence alone.
   Escalate as a financial policy decision before writing real-money code.

## Required Sequencing

1. Safe wiring:
   - Keep `omniston_ton` gated until proof is complete.
   - Allow checkout/Mini App UI to create Telegram-bound spend intents.
   - Return TON payment instructions with the exact spend-intent comment.
   - Continue using `ton_testnet_transfer` for dev/test E2E of the Telegram
     wallet approval, comment binding, and async state transitions.

2. Choose the bridge:
   - Name the TON-to-Base USDC bridge before designing live proof.
   - Record its receipt shape, API guarantees, route identifiers, latency,
     finality model, replay guarantees, and trust assumptions.
   - Omniston / STON.fi is TON-native swap infrastructure; it is not by itself a
     TON-to-Base bridge.
   - No real-money dependency for this step. If STON.fi / Omniston cannot be
     exercised on testnet, bridge selection still proceeds from provider docs,
     API contracts, local mocks, and testnet primitives for Pirate-owned proof
     code. Do not require a mainnet swap/bridge canary to complete Step 2.

3. Proof extension:
   - Add a bridged-receipt attribution path scoped to the selected bridge.
   - Verify the TON source leg with exact payload binding.
   - Verify the Base USDC delivery leg independently.
   - Bind both legs through route-specific evidence.
   - Enforce idempotency: one TON source tx can satisfy at most one spend intent,
     and one Base delivery tx/effect can be consumed once.
   - Model dual-chain finality explicitly.
   - Keep direct `pirate_checkout` receipts on the existing strict
     `from == buyerAddress` path.

4. Live canaries:
   - Blocked until the team explicitly allows tiny real-money testing.
   - Exercise STON.fi / Omniston plus the chosen bridge on mainnet only, with
     tiny amounts.
   - Reconcile source leg, Base delivery, spend intent state, purchase unlock,
     and accounting artifacts before enabling broader traffic.

## Step 2 Bridge Evaluation Without Real Money

STON.fi / Omniston not supporting testnet must not force production-money
testing during bridge selection. Step 2 should produce a bridge decision record,
not a live canary.

Evaluate each candidate bridge against:

- Lookup contract: whether a TON source tx or route order id can resolve to the
  exact Base USDC delivery tx hash.
- On-chain proofability: whether both the TON source leg and Base delivery leg
  can be independently verified from chain data.
- Destination support: whether the route can deliver to a shared operator
  address and whether per-intent Base destination addresses are supported.
- Replay/idempotency model: whether route/order ids and tx hashes are stable
  enough to enforce one source payment -> one spend intent -> one Base delivery.
- Finality model: required confirmations/finality signals on both TON and Base.
- Failure surface: underdelivery, late delivery, bridge failure, cancelled route,
  and refund evidence.
- Trust boundary: what bridge/provider data is used only for correlation versus
  what is verified on-chain.

The implementation work allowed before real-money testing is limited to:

- Provider adapter interfaces and fixture-based contract tests.
- Mock bridge responses that exercise successful delivery, pending delivery,
  underdelivery, late delivery, route failure, replay, and mismatched tx cases.
- The mock bridge should use the existing `omniston_ton` provider slot under a
  dev/test-only resolver rather than adding a second mock provider enum. This
  exercises the future provider lifecycle while keeping `omniston_ton`
  unavailable for real user selection.
- Dev reachability must use separate routes hidden behind
  `PIRATE_OMNISTON_SIM_ENABLED`, not the production accept-provider gate. The
  normal `/telegram/spend-intents/accept` flow must continue rejecting
  `omniston_ton` until the real proof extension is approved.
- `PIRATE_OMNISTON_SIM_ENABLED` is a dev/staging-only switch and must be absent
  from production Worker vars/secrets. Production deploy review must confirm
  this flag is not configured before shipping any build containing the
  `/telegram/spend-intents/omniston-sim/*` routes.
- TON testnet source-leg parsing using the existing
  `ton_testnet_transfer` simulation.
- Base Sepolia or local/forked Base USDC delivery verification for the Base leg
  verifier shape.

Do not enable `omniston_ton` for real users until a bridge is selected, the
proof extension passes mocked/forked tests, and a separately approved mainnet
canary plan exists.

### Candidate Snapshot

This snapshot is based on primary provider docs checked on 2026-06-29. It is a
research gate, not production approval.

| Candidate | Current read | Fit for no-real-money Step 2 |
| --- | --- | --- |
| Symbiosis | Documents cross-chain swaps where one side can be TON and exposes a testnet app/API surface. It is the strongest candidate to inspect first because it is closest to the product shape: user pays from TON, route delivers on another chain. | Best provisional candidate for adapter-interface research and fixture design. Still needs proof that a route/order lookup can deterministically resolve TON source tx -> Base USDC delivery tx. |
| deBridge | Strong cross-chain order/transaction tracking model, but the checked supported-chain docs did not list TON. | Not viable for this TON source path unless TON support is confirmed in current provider docs or by provider support. Keep as a comparison model for order-reference design. |
| LayerZero | Lists both TON and Base endpoints, but this is messaging/OFT infrastructure, not a turnkey consumer bridge from Telegram Wallet TON-side funds to Base USDC. | Useful background for custom infrastructure, but too large for the immediate product rail. Not selected for Step 2 unless the team chooses to build/operate a custom OFT/bridge path. |
| STON.fi / Omniston | TON-native swap infrastructure, and STON.fi testnet support is not available for the needed route. It is not by itself the TON -> Base bridge. | Can remain the TON-side swap component in a later design, but Step 2 must not depend on exercising it on testnet or mainnet. |

### Provisional Step 2 Recommendation

Proceed with a Symbiosis-first proof-contract evaluation, while keeping the
provider name behind an adapter and leaving `omniston_ton` disabled.

Definition of done for this no-real-money evaluation:

- Obtain or confirm the route/order API contract needed to map a TON payment or
  route id to the exact Base delivery tx hash.
- Confirm whether destination addresses are caller-selected, and specifically
  whether per-intent Base destination addresses are possible.
- Write fixtures for successful delivery, pending delivery, underdelivery, late
  delivery, cancelled route, replay, mismatched TON source tx, and mismatched
  Base delivery tx.
- Implement only provider-neutral adapter interfaces and tests against those
  fixtures.
- Keep all on-chain verification independent: provider data may locate txs, but
  TON and Base tx contents must still be checked from chain data.

If Symbiosis cannot provide the lookup contract or destination controls above,
Step 2 remains open and no bridge is selected. Do not fall back to real-money
experiments to answer those questions.

### Symbiosis Desk Evaluation

Checked against the public Symbiosis cross-chain API on 2026-06-29 without
moving funds.

Findings that support continuing:

- Symbiosis lists TON as chain `85918` and Base as chain `8453`.
- Symbiosis v2 tokens list native Base USDC
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, matching the Pirate canonical
  Base USDC token.
- A no-money `POST /crosschain/v2/quote` probe for TON USDT -> native Base USDC
  returned `200 OK`, a `type: "ton"` route, TON wallet messages, and a
  `tokenAmountOut` on native Base USDC.
- Symbiosis exposes tx lookup endpoints keyed by source chain id and source tx
  hash (`/crosschain/v1/tx/{chainId}/{transactionHash}` and v2 equivalent).
  The response schema includes status plus source and destination tx objects,
  which matches the route-locator shape needed by the bridged proof model.
- Quote requests include caller-supplied `from` and `to`; the API shape appears
  compatible with sending the Base delivery to an operator or per-intent Base
  destination address. This still needs fixture validation against the exact
  route before being treated as guaranteed.
- A no-money quote probe with two different Base `to` addresses returned `200 OK`
  for both and preserved the final output as native Base USDC. This is positive
  evidence for per-intent destination support, but it does not replace a tx
  lookup fixture proving the final delivered tx actually pays the requested
  address.

Important corrections and open checks:

- The v1 direct-routes endpoint lists TON -> Base routes, but not a direct route
  to native Base USDC; the successful v2 quote used a mixed route that bridges
  to Base USDbC and then swaps to native Base USDC on Base. The proof extension
  must verify the final Base native-USDC delivery tx, not assume a one-hop
  bridge.
- The TON wallet message payload is generated by Symbiosis. There is no evidence
  yet that Pirate can inject `expectedTonPayload(spend_intent_id)` into the real
  Symbiosis TON payment. Treat the exact TON memo as a simulation invariant, not
  a production invariant, until Symbiosis confirms custom payload support.
- OpenAPI inspection found required `from` and `to` fields but no obvious custom
  TON memo/payload field in the swap request shape. Treat memo injection as
  unsupported unless provider docs/support confirm otherwise.
- If custom TON payloads are unavailable, production attribution must bind the
  Telegram session, selected source wallet, submitted source tx hash, Symbiosis
  route lookup, and verified Base delivery tx. A shared operator Base address
  would make this provider-trust-heavy; per-intent Base destination support is
  the likely requirement for keeping an on-chain spend-intent binding.
- Need a persisted quote fixture and a tx-lookup fixture before implementation:
  confirm which response field is the destination Base tx hash, how finality is
  represented beyond pending/success/stuck/reverted, and whether per-intent
  `to` addresses are honored for this exact TON -> Base USDC route.

Current read: Symbiosis is viable enough to shape the next adapter contract and
web dev UI, but it is not production-approved. The next no-money step is to
answer the attribution decision tree:

1. Can Symbiosis attach Pirate's exact TON memo/payload?
2. If not, can Symbiosis reliably deliver to caller-supplied per-intent Base
   destination addresses for the TON -> native Base USDC route?
3. If neither is true, Symbiosis remains useful as a UX prototype but is likely
   not acceptable for real unlocks under the current canonical-receipt policy.

Capture sanitized v2 quote fixtures and tx-lookup fixtures, then update the mock
adapter to match that contract while keeping `omniston_ton` disabled.

Reference docs:

- Symbiosis cross-chain swaps: https://docs.symbiosis.finance/main-concepts/symbiosis-cross-chain-swaps
- Symbiosis testnet: https://docs.symbiosis.finance/user-guide/testnet
- Symbiosis OpenAPI: https://api.symbiosis.finance/crosschain/openapi.json
- deBridge supported chains: https://docs.debridge.com/the-core-protocol/debridge-infrastructure/supported-chains
- deBridge transaction tracking: https://docs.debridge.com/the-core-protocol/debridge-infrastructure/transaction-tracking
- LayerZero deployed contracts/endpoints: https://docs.layerzero.network/v2/deployments/deployed-contracts

## Step 1 Implementation Checklist

Step 1 is ready to build now because it does not change the financial proof
model. It must keep `omniston_ton` unavailable for real purchases and must use
`ton_testnet_transfer` only as a labelled simulation path.

Already present on this branch:

- Control-plane `spend_intents` schema supports Telegram-first orders:
  `telegram_user_id` is required, while `user_id`, `buyer_address`,
  `community_id`, `quote_id`, and settlement refs can resolve later.
- Telegram Mini App routes verify `init_data` before accepting or confirming
  spend-intent actions.
- `/telegram/spend-intents/accept` moves an intent from proposed/approved to
  `funding_pending` and returns payment instructions.
- `selectFundingProvider` keeps `omniston_ton` gated and only allows
  `ton_testnet_transfer` when `PIRATE_TON_TESTNET_ENABLED=true`.
- `ton_testnet_transfer` returns explicit test-labelled TON instructions with
  the exact `expectedTonPayload(spend_intent_id)` comment.
- `/telegram/spend-intents/ton-testnet/confirm` is hidden unless testnet mode is
  enabled and advances only the simulated funding state.
- Funding acquisition state stores route/source/Base refs with idempotency and
  provider/status indexes.

Net-new API work for Step 1:

- Expose or adapt a Telegram checkout/proposal endpoint that can create a
  Telegram-bound spend intent without requiring a Privy-backed `user_id` or an
  already connected EVM `buyer_address`.
- Keep existing wallet-bound `pirate_checkout` proposal behavior intact; the
  Telegram Wallet path is a separate pre-money proposal/intent flow.
- Known gap: a Telegram-first pre-money intent does not yet have a wired
  proposed -> approved-with-resolved-quote path. That means
  `pirate_checkout` via Telegram-first checkout remains intentionally
  unreachable in Step 1; only the `ton_testnet_transfer` simulation is expected
  to work for this path.
- Return enough payment-instruction metadata for the Mini App to render a TON
  testnet simulation: recipient, exact comment, test label, and current intent
  status.
- Add focused route tests for the Telegram-only creation path and for preserving
  the `omniston_ton` gate.

Net-new web / Mini App work for Step 1:

- Detect Telegram Mini App context from `window.Telegram.WebApp.initData`.
- On a Telegram checkout surface, offer `Pay with Telegram Wallet` only for the
  test/simulation rail while `omniston_ton` remains gated.
- Call the spend-intent accept endpoint with `provider=ton_testnet_transfer`
  when test mode is enabled.
- Render recipient, exact TON comment, and a clear test/simulation label.
- Provide a confirm/poll action that submits the TON testnet tx hash to
  `/telegram/spend-intents/ton-testnet/confirm`.
- Keep non-Telegram web checkout on the existing crypto checkout path.

Step 1 definition of done:

- A Telegram Mini App user can create or open a proposed spend intent without
  Privy.
- The UI can accept the proposal with `ton_testnet_transfer` in test mode and
  displays the exact `expectedTonPayload(spend_intent_id)` comment.
- A simulated TON testnet transfer with the exact comment advances the intent
  through the async funding states.
- The flow never marks `purchaseComplete`, `fundsMoved`, `settled`, or unlocked
  on the simulation path.
- `omniston_ton` remains rejected for real purchase selection.
- Focused API tests and one Mini App/browser E2E cover create-intent -> wallet
  instructions -> TON confirm -> state update.

## Open Decision

Select the actual TON-to-Base USDC bridge.

Until that bridge is named and its proof surface is reviewed, `omniston_ton`
should remain unavailable for real purchases.

## Open Questions For The Proof PR

- Lookup contract: define the exact route/bridge order reference used to resolve
  a TON source tx into a Base USDC tx hash.
- Per-intent Base destination: decide whether to keep the shared operator
  address or issue/use per-order destination addresses.
- Underdelivery: specify what happens when the Base delivery is confirmed but
  below the expected quote amount.
- Bridge failure: specify refund and support handling when the TON source leg is
  paid but no Base delivery arrives.
- Late delivery: specify whether an expired spend intent can still settle, be
  reopened, or require manual reconciliation.
- Overdelivery: decide whether excess Base USDC is retained as route buffer or
  refunded.
