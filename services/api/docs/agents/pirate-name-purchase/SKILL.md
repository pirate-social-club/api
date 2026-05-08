# Pirate .pirate Name Purchase

Use this skill when a user asks an agent to quote or buy a global `.pirate` name without opening the Pirate website.

## Safety Rules

- Require an explicit `max_usd` from the user before initiating any paid claim.
- Never pay if the quoted `price_cents` is greater than `max_usd * 100`.
- Show the user the label, price, chain, token, recipient, amount, and quote expiry before payment.
- Do not print, log, paste, or request private keys. Use a wallet tool, secure secret store, or hosted signing flow.
- Verify payment instructions exactly. The chain id, token address, recipient address, and atomic amount must match the quote.
- Do not retry payment with a new transaction after a timeout until checking whether the first transaction was confirmed.
- If the claim retry succeeds once, replaying the same quote/proof may return the same handle; treat that as success.

## Inputs

Required:

- `api_origin`: Pirate API origin, for example `https://api.pirate.sc` or staging `https://api-staging.pirate.sc`
- `access_token`: Bearer token for the user/profile that will own the name
- `desired_label`: name to quote, with or without `.pirate`
- `max_usd`: maximum authorized spend
- a wallet capable of sending the quoted stablecoin on the quoted chain

Optional:

- `settlement_wallet_attachment`: wallet attachment id. If omitted, Pirate uses the authenticated user's primary wallet.

## Protocol

### 1. Request Terms

```http
POST {api_origin}/profiles/me/global-handle/x402-claim
Authorization: Bearer {access_token}
Content-Type: application/json
```

```json
{
  "desired_label": "olivia"
}
```

If payment is required, Pirate returns `402 payment_required` with quote details:

```json
{
  "code": "payment_required",
  "retryable": true,
  "details": {
    "quote": "ghq_...",
    "desired_label": "olivia.pirate",
    "price_cents": 10000,
    "currency": "USD",
    "payment_protocol": "x402",
    "policy_version": "global_handle_paid_v1",
    "pricing_tier": "first_name",
    "quote_ttl_seconds": 900,
    "expires_at": 1770000000,
    "payment_instructions": {
      "chain": {
        "chain_namespace": "eip155",
        "chain_id": 8453,
        "display_name": "Base"
      },
      "token_address": "0x...",
      "recipient_address": "0x...",
      "amount_atomic": "100000000",
      "amount_display": "100.00"
    }
  }
}
```

If the API returns `200`, inspect the body:

- `eligible: true`, `price_cents: 0`: free claim path; no payment is required.
- `eligible: false`: do not pay. Surface `reason` to the user.

### 2. Validate Before Paying

Before sending funds:

- `details.quote` must be present.
- `details.price_cents` must be positive and `<= max_usd * 100`.
- `details.payment_instructions.chain.chain_namespace` must be `eip155`.
- The wallet must be on `details.payment_instructions.chain.chain_id`.
- The transfer token must be `details.payment_instructions.token_address`.
- The transfer recipient must be `details.payment_instructions.recipient_address`.
- The transfer amount must be exactly `details.payment_instructions.amount_atomic` or greater.
- The current time must be before `expires_at`.

### 3. Send Payment

Send the quoted token transfer from the authenticated user's wallet to the quoted recipient on the quoted chain.

For USDC-style 6-decimal tokens:

```text
amount_atomic = USD amount * 1_000_000
```

Do not assume decimals from the display string. Use the quoted `amount_atomic`.

### 4. Retry With Proof

After the transaction is confirmed, retry the endpoint with the quote and transaction hash:

```http
POST {api_origin}/profiles/me/global-handle/x402-claim
Authorization: Bearer {access_token}
Content-Type: application/json
```

```json
{
  "quote": "ghq_...",
  "funding_tx_ref": "0x..."
}
```

Include `settlement_wallet_attachment` only if the user explicitly selected a non-primary wallet attachment:

```json
{
  "quote": "ghq_...",
  "funding_tx_ref": "0x...",
  "settlement_wallet_attachment": "wla_..."
}
```

Success returns a `global_handle` with `issuance_source: "paid_upgrade"`.

## Error Handling

- `400 bad_request`: malformed input, missing quote, or missing wallet attachment.
- `402 payment_required`: expected during terms discovery; pay only after safety checks.
- `403 eligibility_failed`: expired quote, changed policy, invalid payment, or settlement-wallet issue. Request a fresh quote.
- `404 not_found`: quote does not belong to this user or no longer exists.
- `409 conflict`: another user claimed the label first.

## Reference Implementation

Use `scripts/smoke-paid-global-handle.ts` as the maintained implementation reference for quote, payment, claim, and replay behavior.

Staging quote-only example:

```bash
rtk infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  bun scripts/smoke-paid-global-handle.ts \
  --origin https://api-staging.pirate.sc \
  --label olivia
```

Staging claim example, using a private key from Infisical:

```bash
rtk infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  bun scripts/smoke-paid-global-handle.ts \
  --origin https://api-staging.pirate.sc \
  --label olivia \
  --claim
```
