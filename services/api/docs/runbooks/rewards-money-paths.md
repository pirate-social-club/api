# Rewards Money-Path Operations

Use this runbook to investigate reward campaign funding and user cashout
settlement. Start read-only. Do not submit a replacement transaction, mutate a
database row directly, or bypass the signing coordinator while the outcome of a
prior transaction is ambiguous.

## First classify the incident

Funding and settlement answer different questions:

- **Funding:** can the operator wallet pay gas and transfer USDC? Use the wallet
  watchdog alerts and `GET /admin/ops/wallets`.
- **Settlement:** did one intended cashout produce exactly one payout, and is an
  ambiguous broadcast being reconciled safely? Use the payout record,
  coordinator reference, transaction receipt, and settlement diagnostics.

A healthy wallet report does not prove that a payout settled exactly once. A
settlement failure does not by itself mean the wallet is underfunded.

## Read-only wallet check

The endpoint requires the production admin token and returns `private,
no-store` data. Keep the token out of shell history and captured incident logs.

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Operator ${PIRATE_ADMIN_OPERATOR_CREDENTIAL:?}" \
  "https://api.pirate.sc/admin/ops/wallets"
```

Read the top-level `ok` value and then the individual wallet entries. For reward
cashouts, inspect `base-rewards-operator` in particular:

- `native.ok` covers the configured gas-token floor.
- `usdc.ok` covers the configured USDC floor.
- `error` means the balance check itself failed; it is not evidence that the
  balance is zero.

The scheduled runtime-wallet and Story-signer watchdogs cover the same funding
surfaces. Story signer failures may be unrelated to a Base reward cashout, so
use the wallet name and chain ID before joining alerts into one incident.

## Read-only settlement check

Find the payout's stored idempotency key and use it as the coordinator reference.
For a cashout it has the JSON shape `["reward_payout", "<idempotency-key>"]`.
URL-encode the complete JSON value as the `coordinator_ref` query parameter.

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Operator ${PIRATE_ADMIN_OPERATOR_CREDENTIAL:?}" \
  "https://api.pirate.sc/admin/ops/rewards-settlement-diagnostics?coordinator_ref=<url-encoded-json>"
```

Capture these fields with the corresponding payout record and chain receipt:

- `state`
- `nonce`
- `attempt_count`
- `transaction_present`
- `transaction_hash`
- `preparation_failure`
- `settlement_failure`

Investigate when any of the following is true:

1. A submitted payout does not progress to a terminal state.
2. `attempt_count` keeps increasing without a conclusive receipt.
3. One intended payout appears to have more than one transaction hash.
4. An ambiguous broadcast is not parked pending reconciliation.
5. A replacement is attempted before the previous nonce is conclusively absent
   or mined.
6. A user retry creates another payout instead of replaying the original
   idempotent result.

The implementation already defends these paths with idempotency keys, a single
submitted payout per user, nonce coordination, and ambiguous-response
reconciliation. Monitoring confirms those invariants in production; it does not
replace them.

## Kill switches and coupling

All three flags fail closed: after trimming and lowercasing, only `true` enables
them.

| Flag | Effect when disabled |
| --- | --- |
| `REWARDS_CAMPAIGNS_ENABLED` | Hides and disables reward campaigns while leaving cashout available. |
| `REWARDS_PAYOUTS_ENABLED` | Rejects cashout writes, reports cashout as ineligible, and also disables reward campaigns. |
| `REWARDS_ACCRUAL_ENABLED` | Stops reward accrual and also disables reward campaigns. |

The switches are intentionally asymmetric:

- Cashout enabled with campaigns disabled is supported.
- Campaigns enabled with payouts disabled is not supported.

For a boost-only incident, disable campaigns. For a cashout or settlement
incident, disable payouts and expect boost entry points to disappear too. That
second symptom is the designed dependency, not evidence of a cascading outage.
Apply flag changes only through the reviewed configuration and deployment path.

## Safe incident handling

1. Preserve the payout, coordinator, receipt, wallet, and alert evidence before
   changing configuration.
2. Classify funding separately from settlement.
3. Use the narrowest kill switch that contains the affected write path.
4. Let the coordinator and reconciler establish whether an ambiguous
   transaction landed.
5. Use the authenticated operator settlement-resolution workflow only after the
   receipt and intended resolution have been independently verified.
6. Do not repair reward state with raw production database writes, manually
   replace a transaction, or reuse an idempotency key for a different amount or
   destination.

Before re-enabling a switch, confirm wallet floors, coordinator state, the chain
receipt, payout state, and the absence of a duplicate submitted payout.
