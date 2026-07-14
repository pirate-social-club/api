# Agent .pirate Name Purchase

Agents buy wallet-owned `.pirate` names through the public name purchase API.

## Endpoints

- `POST /public-names/quotes`
- `POST /public-names/claims`
- `GET /public-names/:label/status`

Auth: none. The buyer wallet address in the quote owns the registration and must send the checkout USDC payment.

## Quote

```json
{
  "desired_label": "captain",
  "buyer_wallet_address": "0x2000000000000000000000000000000000000002"
}
```

Successful response:

```json
{
  "quote": "pnq_...",
  "desired_label": "captain.pirate",
  "label_normalized": "captain",
  "buyer": {
    "kind": "wallet",
    "wallet_address": "0x2000000000000000000000000000000000000002",
    "chain_ref": "eip155:84532"
  },
  "price_cents": 25000,
  "currency": "USD",
  "eligible": true,
  "reason": null,
  "policy_version": "global_handle_paid_v1",
  "pricing_tier": "common_word",
  "quote_ttl_seconds": 900,
  "expires_at": 1770000000,
  "payment_instructions": {
    "chain": {
      "chain_namespace": "eip155",
      "chain_id": 84532,
      "display_name": "Base"
    },
    "token_address": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "recipient_address": "0x...",
    "amount_atomic": "250000000",
    "amount_display": "250.00"
  }
}
```

## Claim

After funding the exact `payment_instructions` from `buyer.wallet_address`, submit:

```json
{
  "quote": "pnq_...",
  "funding_tx_ref": "0x..."
}
```

Successful response:

```json
{
  "registration": {
    "id": "pnr_...",
    "label": "captain.pirate",
    "label_normalized": "captain",
    "status": "active",
    "owner_kind": "wallet",
    "owner_wallet_address": "0x2000000000000000000000000000000000000002",
    "chain_ref": "eip155:84532",
    "price_paid_cents": 25000,
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

## Guarantees

- Quote TTL is authoritative.
- Claim verifies the funding transaction came from the quote's buyer wallet.
- Claim rechecks current pricing policy before registering the name.
- Replaying the same paid quote returns the already issued registration.
- Concurrent claims for the same label resolve through active-label constraints and transactional checks.

## Errors

- `400 bad_request`: malformed request, invalid buyer wallet, or missing funding proof.
- `403 eligibility_failed`: expired quote, policy drift, reserved label, or invalid payment.
- `404 not_found`: quote not found.
- `409 conflict`: another wallet or Pirate user claimed the label first.
