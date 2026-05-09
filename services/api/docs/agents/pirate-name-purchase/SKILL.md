---
name: pirate-name-purchase
description: Buy a wallet-owned .pirate name through Pirate's public x402-compatible checkout API. Use when a user asks an agent to quote, pay for, or claim a .pirate domain/name without a Pirate or Privy account.
---

# Public .pirate Name Purchase

Use this skill when a user asks an agent to quote or buy a `.pirate` name without opening the Pirate website or authenticating with Pirate.

The public flow is wallet-bound. The buyer wallet in the quote must be the wallet that sends the checkout USDC transfer and will own the registration.

## Safety Rules

- Require an explicit `max_usd` from the user before initiating any paid claim.
- Never pay if the quoted `price_cents` is greater than `max_usd * 100`.
- Show the user the label, buyer wallet, price, chain, token, recipient, amount, and quote expiry before payment.
- Do not print, log, paste, or request private keys. Use a wallet tool, secure secret store, or hosted signing flow.
- Verify payment instructions exactly. The chain id, token address, recipient address, and atomic amount must match the quote.
- The payment must be sent from `quote.buyer.wallet_address`.
- Do not retry payment with a new transaction after a timeout until checking whether the first transaction was confirmed.
- If the claim retry succeeds once, replaying the same quote/proof may return the same registration; treat that as success.

## Inputs

Required:

- `api_origin`: Pirate API origin, for example `https://api.pirate.sc` or staging `https://api-staging.pirate.sc`
- `desired_label`: name to quote, with or without `.pirate`
- `buyer_wallet_address`: EVM wallet that will pay and own the registration
- `max_usd`: maximum authorized spend
- a wallet capable of sending the quoted stablecoin on the quoted chain

No Bearer token, Privy account, or Pirate user session is required.

## Protocol

### 1. Optional Status Check

```http
GET {api_origin}/public-names/{desired_label}/status
```

Responses:

- `status: "available"`: request a quote.
- `status: "registered"`: already wallet-owned through the public flow.
- `status: "taken"`: already owned by a Pirate user profile.

### 2. Request Quote

```http
POST {api_origin}/public-names/quotes
Content-Type: application/json
```

```json
{
  "desired_label": "olivia",
  "buyer_wallet_address": "0x2000000000000000000000000000000000000002"
}
```

Successful response:

```json
{
  "quote": "pnq_...",
  "desired_label": "olivia.pirate",
  "label_normalized": "olivia",
  "buyer": {
    "kind": "wallet",
    "wallet_address": "0x2000000000000000000000000000000000000002",
    "chain_ref": "eip155:8453"
  },
  "price_cents": 10000,
  "currency": "USD",
  "eligible": true,
  "reason": null,
  "policy_version": "global_handle_paid_v1",
  "pricing_tier": "first_name",
  "quote_ttl_seconds": 900,
  "quoted_at": 1770000000,
  "expires_at": 1770000900,
  "payment_instructions": {
    "chain": {
      "chain_namespace": "eip155",
      "chain_id": 8453,
      "display_name": "Base"
    },
    "token_address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "recipient_address": "0x...",
    "amount_atomic": "100000000",
    "amount_display": "100.00"
  }
}
```

### 3. Validate Before Paying

Before sending funds:

- `quote` must be present.
- `price_cents` must be positive and `<= max_usd * 100`.
- `payment_instructions.chain.chain_namespace` must be `eip155`.
- The wallet must be on `payment_instructions.chain.chain_id`.
- The transfer token must be `payment_instructions.token_address`.
- The transfer recipient must be `payment_instructions.recipient_address`.
- The transfer amount must be exactly `payment_instructions.amount_atomic` or greater.
- The sender must be `buyer.wallet_address`.
- The current time must be before `expires_at`.

### 4. Send Payment

Send the quoted token transfer from the buyer wallet to the quoted recipient on the quoted chain.

For USDC-style 6-decimal tokens:

```text
amount_atomic = USD amount * 1_000_000
```

Do not assume decimals from the display string. Use the quoted `amount_atomic`.

### 5. Claim With Funding Proof

After the transaction is confirmed, claim with the quote and transaction hash:

```http
POST {api_origin}/public-names/claims
Content-Type: application/json
```

```json
{
  "quote": "pnq_...",
  "funding_tx_ref": "0x..."
}
```

Success returns:

```json
{
  "registration": {
    "id": "pnr_...",
    "label": "olivia.pirate",
    "label_normalized": "olivia",
    "status": "active",
    "owner_kind": "wallet",
    "owner_wallet_address": "0x2000000000000000000000000000000000000002",
    "chain_ref": "eip155:8453",
    "price_paid_cents": 10000,
    "currency": "USD",
    "issued_at": 1770000100,
    "expires_at": null,
    "pirate_user_id": null
  },
  "quote": "pnq_...",
  "funding_tx_ref": "0x...",
  "settlement_tx_ref": "0x..."
}
```

## Error Handling

- `400 bad_request`: malformed input, invalid buyer wallet, missing quote, or missing funding transaction.
- `403 eligibility_failed`: expired quote, changed policy, reserved label, invalid payment, or unavailable label.
- `404 not_found`: quote no longer exists.
- `409 conflict`: another wallet or user claimed the label first.

## Reference Implementation

Use `scripts/smoke-public-pirate-name.ts` as the maintained implementation reference for quote, payment, claim, and replay behavior.

Staging quote-only example:

```bash
rtk env infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  bun scripts/smoke-public-pirate-name.ts \
  --origin https://api-staging.pirate.sc \
  --label olivia
```

Staging claim example, using a private key from Infisical:

```bash
rtk env infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  bun scripts/smoke-public-pirate-name.ts \
  --origin https://api-staging.pirate.sc \
  --label olivia \
  --claim
```

Production quote-only example:

```bash
rtk env infisical run --project-config-dir ../../../core --env prod --path /services/api -- \
  bun scripts/smoke-public-pirate-name.ts \
  --origin https://api.pirate.sc \
  --label olivia
```

Production claim example, using a funded Base mainnet buyer wallet:

```bash
rtk env infisical run --project-config-dir ../../../core --env prod --path /services/api -- \
  bun scripts/smoke-public-pirate-name.ts \
  --origin https://api.pirate.sc \
  --label olivia \
  --claim
```
