# Agent .pirate Handle Purchase

Agents buy paid global `.pirate` names through the same authenticated profile and quote ledger used by the human Settings flow.

## Endpoint

`POST /profiles/me/global-handle/x402-claim`

Auth: Bearer user session token. For v1, agents authenticate as wallet-backed users; the claimed handle attaches to that profile.

## Request A: Ask For Payment Terms

```json
{
  "desired_label": "captain"
}
```

If the name requires payment, the API returns `402 payment_required`.

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

If the quote is free or not payable, the API returns the quote body with `200` instead of a payment challenge.

## Request B: Retry With Payment Proof

After funding the exact `payment_instructions`, retry with the quote and transaction reference.

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

## Guarantees

- Quote TTL is authoritative.
- Claim rechecks current pricing policy before issuing the handle.
- Replaying the same paid quote returns the already issued handle.
- Concurrent claims for the same label resolve through the unique active-label constraint.

## Errors

- `400 bad_request`: malformed request or missing `quote` on paid retry.
- `402 payment_required`: payment terms are available and no proof was supplied.
- `403 eligibility_failed`: expired quote, policy drift, unavailable settlement wallet, or invalid claim eligibility.
- `404 not_found`: quote not found for the authenticated user.
- `409 conflict`: another user claimed the label first.
