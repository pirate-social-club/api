# Production Worker testnet configuration audit

Status: read-only classification; no configuration changes authorized

Scope: every checked-in testnet value in the `production` vars block of
`services/api/wrangler.jsonc` at API `6241fb92c15d26a1c895937ccc47a0e25272617b`.

Classification meanings:

- **deliberate test-only system** — production-hosted product behavior is
  intentionally anchored to a testnet and the surrounding runtime agrees.
- **dormant-but-armed** — configuration exists, but a separate runtime boundary
  prevents or gates its use; changing one side could activate value movement.
- **copy-paste defect** — the production runtime expects mainnet, while a
  testnet value can currently be consumed as if it were production.

## Inventory

| Production value | Consumer and evidence | Classification |
| --- | --- | --- |
| `STORY_RPC_URL=https://aeneid.storyrpc.io` | `resolveStoryRpcUrl` uses it directly; the default chain is Story Aeneid `1315`, delivery contracts are Aeneid addresses, and the production money policy labels the destination `Story Aeneid`. | deliberate test-only system |
| `STORY_RPC_FALLBACK_URLS=https://rpc.ankr.com/story_aeneid_testnet` | `resolveStoryRpcUrls` appends it to the Aeneid primary; it is the same explicitly versioned Story testnet system. | deliberate test-only system |
| `STORY_SETTLEMENT_FEE_POLICY_VERSION=aeneid-coordinator-fee-v1` | Policy name matches the Aeneid coordinator and its checked-in fee limits. | deliberate test-only system |
| `STORY_SETTLEMENT_FINALITY_POLICY_VERSION=aeneid-safe-finality-v1` | Policy name and the `1315` runtime agree on Aeneid finality. | deliberate test-only system |
| `PIRATE_CHECKOUT_SOURCE_CHAIN_ID=84532` | Commit `d60db264f6` / API #426 explicitly changed production checkout from Base mainnet to Base Sepolia. API #999 later added a production fail-closed check requiring `8453`; with the current vars, checkout resolution throws before producing payment instructions. | dormant-but-armed |
| `PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS=0x036c…cF7e` | Canonical Base Sepolia USDC paired with checkout chain `84532`; unreachable in production while the API #999 mainnet-only resolver guard holds. | dormant-but-armed |
| `PIRATE_BOOKING_SETTLEMENT_CHAIN_ID=84532` | Booking settlement explicitly allowlists Base Sepolia and Base mainnet. Unlike global checkout, it has no production-mainnet-only check. API #426 added this production value intentionally, and booking receipt/reverification code consumes it. | deliberate test-only system |
| `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org` | Shared fallback used by Base Sepolia checkout and booking settlement. Checkout is runtime-blocked; booking settlement intentionally consumes it. | deliberate test-only system (booking) and dormant dependency (checkout) |
| implicit booking USDC `0x036c…cF7e` | No production override is needed: both booking config modules map chain `84532` to canonical Base Sepolia USDC. | deliberate test-only system |

## Adjudication

No checked-in value is an unguarded copy-paste defect at this SHA:

- Story is consistently Aeneid from chain id through contracts, policy names,
  RPCs, and public money-policy serialization.
- Booking settlement is intentionally Base Sepolia. This is production-hosted
  testnet commerce, not Base-mainnet commerce; changing it is a product and
  custody launch, not a correction.
- Checkout contains stale/testnet production vars, but API #999 makes them
  fail closed. It is currently unavailable rather than silently charging on
  the wrong chain. Activating checkout requires a reviewed mainnet tuple
  (chain, canonical USDC, RPC, operator/custody) and a funded acceptance run.

## Regression-guard decision

The API #949 reward guard already rejects every reward testnet value in the
production block. API #999 separately tests that production checkout rejects
Base Sepolia. Booking and Story testnet values are intentional, so extending a
blanket `production must not contain testnet` assertion would incorrectly ban
two reviewed systems.

Therefore this audit adds no configuration mutation and no broader string
ban. The next guard belongs with an approved checkout-mainnet activation: at
that point, extend the checked-in production-config assertion to the checkout
chain/token/RPC tuple in the same commit that supplies and reviews the tuple.
Until then, the runtime mainnet-only checkout assertion is the safety boundary.
