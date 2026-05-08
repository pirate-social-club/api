---
name: pirate-name-purchase
description: Buy a global .pirate name through Pirate's x402 paid-handle API. Use when a user asks an agent to quote, pay for, or claim a .pirate domain/name without visiting the Pirate web app.
---

# Pirate .pirate Name Purchase

Use this skill to quote and claim a global `.pirate` name through Pirate's authenticated x402 purchase flow.

## Safety Rules

- Get explicit user approval before sending any on-chain payment.
- Respect a user-provided max price. If none is provided, ask before paying.
- Never print private keys, bearer tokens, RPC URLs with credentials, or full secret env dumps.
- Do not hardcode the payment rail. Use the `payment_instructions` returned by the API.
- Do not pay if `recipient_address`, `token_address`, `chain_id`, or `amount_atomic` is missing.
- Do not retry with a different quote after payment. Retry the claim with the exact `quote` that produced the payment instructions.
- Treat `expires_at` as authoritative. If the quote expired, request a new quote before paying.

## Endpoint

`POST {PIRATE_API_ORIGIN}/profiles/me/global-handle/x402-claim`

Auth: `Authorization: Bearer {user_session_token}`

For v1, agents act as wallet-backed users. The claimed name attaches to the authenticated user profile.

## Quote

Send the desired label without `.pirate`:

```json
{
  "desired_label": "captain"
}
```

If payment is required, the API returns HTTP `402`:

```json
{
  "code": "payment_required",
  "message": "Payment required to claim this .pirate name",
  "retryable": true,
  "details": {
    "quote": "ghq_...",
    "desired_label": "captain.pirate",
    "price_cents": 2500,
    "currency": "USD",
    "payment_protocol": "x402",
    "policy_version": "global_handle_paid_v1",
    "pricing_tier": "common_word",
    "quote_ttl_seconds": 900,
    "expires_at": 1770000000,
    "payment_instructions": {
      "chain": {
        "chain_namespace": "eip155",
        "chain_id": 84532,
        "display_name": "Base Sepolia"
      },
      "token_address": "0x...",
      "recipient_address": "0x...",
      "amount_atomic": "25000000",
      "amount_display": "25.00"
    }
  }
}
```

If the label is free or non-payable, the API may return HTTP `200` with the quote body instead of a payment challenge. Only pay when the response is `402 payment_required`.

## Payment

After user approval, send exactly `amount_atomic` of the returned ERC-20 token to `recipient_address` on the returned EIP-155 chain.

The current backend verifies a standard ERC-20 `Transfer` event:

- token contract equals `payment_instructions.token_address`
- recipient equals `payment_instructions.recipient_address`
- amount is at least `payment_instructions.amount_atomic`
- sender is the authenticated user's settlement wallet
- transaction has the required confirmation

## Claim

Retry the same endpoint with the quote and funding transaction hash:

```json
{
  "quote": "ghq_...",
  "funding_tx_ref": "0x..."
}
```

`settlement_wallet_attachment` is optional. If omitted, the API uses the authenticated user's primary wallet attachment.

Successful response:

```json
{
  "object": "global_handle",
  "label": "captain.pirate",
  "tier": "premium",
  "status": "active",
  "issuance_source": "paid_upgrade",
  "price_paid_cents": 2500
}
```

## Error Handling

- `400 bad_request`: malformed request, missing quote, or missing settlement wallet.
- `402 payment_required`: terms are available and no proof was supplied.
- `403 eligibility_failed`: expired quote, policy drift, invalid funding proof, or claim eligibility failure.
- `404 not_found`: quote not found for this user.
- `409 conflict`: another user claimed the label first.

If a retry returns the same already issued handle, treat it as success. The claim flow is idempotent by quote.

## Minimal Agent Flow

1. Normalize the requested label by removing a trailing `.pirate`.
2. Ask for a quote.
3. If HTTP `200` returns a successful non-payable claim/quote, report it to the user.
4. If HTTP `402`, show only the label, price, chain, and token to the user.
5. Confirm the price is within the user's max price.
6. Ask for explicit approval to pay.
7. Send the ERC-20 payment using the user's wallet.
8. Retry with `{ "quote": "...", "funding_tx_ref": "0x..." }`.
9. Report the final claimed `.pirate` name.

Reference implementation: `services/api/scripts/smoke-paid-global-handle.ts`.
