# Runbook: reward settlement stop and repair

Use this procedure when a reward cash-out is signed but does not converge to a
retrievable on-chain transaction. The goal is to stop automatic retries,
classify the nonce without guessing, and release or confirm the durable mirror
using the supported operator resolution endpoint.

Never mark an effect confirmed from a locally computed transaction hash. A
signed hash proves only that bytes were created. Confirmation requires a
successful receipt and the expected vault event.

## Required evidence

Record these values before changing state:

- payout effect ID, status, coordinator reference and coordinator state;
- signed transaction hash and reserved nonce;
- preparation stage, attempt count, HTTP status and transport category;
- `eth_getTransactionByHash` and `eth_getTransactionReceipt` results from both
  the configured read RPC and broadcast RPC;
- operator `latest` and `pending` nonces.

Use a short-lived `pg_read_all_data` role for production diagnostics. Use a
short-lived operator credential scoped only to
`rewards:settlement:resolve` for the resolution call, and revoke it immediately
afterward.

## Choose exactly one repair branch

### Proven pre-broadcast failure

Use `failed_prebroadcast` only when evidence proves the request did not reach a
node that could accept it. The transaction must be absent from both RPCs and the
pending nonce must still equal the effect's reserved nonce.

Do not use this branch for a timeout, connection loss/reset after dispatch, or
any other ambiguous send result. Those conditions cannot prove non-broadcast.

The coordinator clears the repaired row's nonce only after its liveness and
pending-nonce guards pass. The next effect may then safely reserve that same
tail nonce.

```json
{
  "effect_kind": "cashout",
  "expected_tx_hash": "0x...",
  "expected_nonce": 7,
  "resolution": "failed_prebroadcast",
  "reason": "Provider rejection proved the request was not submitted."
}
```

### Ambiguous broadcast

A timeout means uncertain, not failed. Stop retries and explicitly consume the
reserved nonce with a reviewed zero-value operator self-transaction carrying a
clear fee bump. Wait for that replacement to mine, then verify all of the
following:

- the replacement receipt succeeded;
- `latest` and `pending` nonces are both greater than the payout nonce;
- the payout hash remains absent from both RPCs.

Only then resolve the effect as `failed_nonce_invalidated`:

```json
{
  "effect_kind": "cashout",
  "expected_tx_hash": "0x...",
  "expected_nonce": 7,
  "resolution": "failed_nonce_invalidated",
  "reason": "Nonce 7 was consumed by confirmed replacement 0x... at block ...."
}
```

The endpoint independently rechecks transaction liveness plus the latest and
pending nonces. It rejects the resolution until the replacement is mined.

## Supported resolution endpoint

Send the selected payload to:

```text
POST /operator/reward_settlements/{effect_id}/resolve
Authorization: Operator {credential_id}.{secret}
```

Issue and revoke the scoped credential with
`scripts/operator-credentials.ts`; never store it in source, documentation, or
shell history. Do not bypass the endpoint with a direct database write.

## Post-repair verification

Before permitting another Claim attempt, verify raw values rather than a
summary:

- repaired payout effect status is `failed`;
- failure reason matches the selected resolution;
- every submitted allocation for the effect is `released`;
- ambiguous repair: replacement is confirmed and chain nonce advanced;
- proven pre-broadcast repair: the next coordinator reservation reuses the
  unchanged chain tail nonce;
- the original payout hash remains absent from both RPCs.

After the next payout, verify the transaction is retrievable through both RPCs,
the vault event matches recipient and amount, the payout effect and allocation
are `confirmed`, campaign `paid_cents` advanced exactly once, and the available
reward balance no longer includes the settled credit.
