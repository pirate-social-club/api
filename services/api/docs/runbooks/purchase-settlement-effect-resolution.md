# Purchase Settlement Effect Resolution

Use this runbook for stale `submitted` rows in `purchase_settlement_effects`.
It covers buyer USDC funding on the configured checkout chain and the Story
royalty payment, parent-vault transfer, and entitlement-mint legs. It is also
the disposition policy for legacy rows when the durable settlement coordinator
is introduced.

The diagnostic is evidence gathering only. A classification never authorizes
a retry, a replacement transaction, a database update, or delivery. There is
currently no supported operator mutation endpoint for these legacy effects.
Never repair them with hand-written SQL.

Legacy `failed_prebroadcast` parent-vault effects no longer auto-rebroadcast.
After classification and positive nonce evidence proves non-broadcast, follow
the legacy disposition section of
`docs/runbooks/story-settlement-coordinator-operations.md`; coordinator nonce
repair is not a substitute for a new reviewed legacy effect generation.

## Collect Evidence

Load read-only Cloudflare credentials and RPC URLs through the normal secret
workflow. Set the expected chain IDs from the deployed checkout and Story
configuration; do not infer them from `production` or `staging`. Production
checkout can intentionally use a test network during rollout.

Run the bounded scanner from `services/api`:

```bash
bun run diagnose:stuck-story-settlements -- \
  --env production \
  --older-than-minutes 30 \
  --funding-rpc-url "${PIRATE_CHECKOUT_RPC_URL}" \
  --funding-chain-id "${PIRATE_CHECKOUT_SOURCE_CHAIN_ID}" \
  --story-rpc-url "${STORY_RPC_URL}" \
  --story-chain-id "${STORY_CHAIN_ID}" \
  --signer-address "${STORY_SETTLEMENT_SIGNER_ADDRESS}"
```

The command exits nonzero if any shard read fails or an RPC reports a chain ID
different from the expected value. Treat `scan_complete: false`, a truncated
per-database result, or either of those failures as an incomplete fleet scan.
Do not conclude that no stuck effects exist.

For every reported row, record the database, community, quote, purchase,
effect ID and kind, transaction hash, evidence chain, timestamps, attempt
count, classification, receipt block identity, transaction sender and nonce.
Do not put RPC credentials, signed transaction bytes, or private keys in the
incident.

## Common Safety Checks

Before selecting a disposition:

1. Re-read the row and stop if it is no longer `submitted`.
2. Read the transaction and receipt from every configured provider. Verify the
   receipt remains canonical at the finality depth approved for that plan.
3. For buyer funding, independently verify chain, USDC contract, sender,
   checkout recipient, exact amount, log index, and the global observed-receipt
   claim. Record whether the claim is unclaimed, owned by this exact
   rail/consumer/quote, or owned by another consumer.
4. For Story effects, verify signer, nonce, destination, value, calldata and
   decoded call identity against the quote and asset plan. Inspect earlier and
   later effects for the same purchase. Delivery must remain last.
5. Open a peer-reviewed repair change or use a purpose-built audited admin
   action. Do not use the ordinary settle route as an incident repair tool.

## Classification Dispositions

### `chain_confirmed_local_stuck`

The chain effect succeeded but the shard did not record confirmation.
Rebroadcasting would risk duplicate payment or minting.

- Buyer funding: if the canonical global claim belongs to another consumer,
  stop as a replay/security incident. If it belongs to this exact consumer and
  quote, or is still unclaimed, the repair must idempotently establish that
  claim and then CAS-confirm the shard effect with freshly verified receipt
  metadata. A partial claim-without-shard-confirm remains safe and retryable.
- Story effect: verify the successful call identity and all prior plan steps.
  A repair may CAS-confirm only this effect and enqueue reconciliation of the
  next planned step. A confirmed entitlement mint does not by itself authorize
  delivery; the repair must verify every preceding effect before writing the
  purchase and entitlement rows.

### `chain_reverted_local_stuck`

A canonical reverted receipt proves that this transaction did not perform the
intended chain effect. Preserve the receipt as immutable evidence.

- Buyer funding: a controlled repair may CAS-fail this hash. A later payment
  must use its own verified transaction hash and global claim.
- Story effect: v1 policy is manual-only regeneration. CAS-fail the legacy
  effect, then create a new plan/effect generation with a new identity. Never
  overwrite the reverted hash or silently reuse the legacy effect identity.

### `chain_pending`

Leave the row unchanged. Do not sign or broadcast anything with the same call
identity or a different nonce. Page on transaction age and inspect the Story
signer's latest/pending nonce when applicable. Fee replacement is an audited
manual operation until the coordinator has a replacement policy; it must use
the same nonce and retain both hashes in the journal.

### `chain_transaction_not_found`

Absence from an RPC is not proof that no broadcast occurred. Recheck every
provider, explorer/indexer and signer history after the approved evidence
window.

- Buyer funding: the platform did not create this transaction, so it must not
  broadcast it. A controlled repair may CAS-fail the effect only after the
  evidence window, and must place any later appearance of that payment into
  `refund_review` rather than consuming it automatically.
- Story effect: keep it in reconciliation-required disposition unless durable
  signed bytes prove an exact-byte rebroadcast is possible, or independent
  signer/nonce evidence proves pre-broadcast failure. Missing signed bytes are
  never permission to freshly sign an ambiguous call.

### `ambiguous_no_transaction_reference`

Keep the effect frozen. For Story effects, correlate provider traces, signer
nonce history and logs around `submitted_at`; without proof of pre-broadcast
failure, disposition it as `reconciliation_required`. A funding effect should
normally derive its hash from `effect_key`; a missing value is data corruption
and requires a code-reviewed repair.

### `invalid_transaction_reference`

Treat this as corrupt local evidence. Do not reinterpret or normalize it into
a different hash. Compare immutable request logs and upstream receipt data,
then use a code-reviewed CAS repair that preserves the bad value in the audit
record. Story effects remain frozen unless a unique canonical transaction can
be proven.

### `chain_evidence_not_requested` or `chain_evidence_unavailable`

No disposition is allowed. Supply the correct chain RPC or restore provider
health and run the scan again. Do not substitute evidence from the other rail's
chain.

## Close the Incident

After an approved repair, rerun the scanner and retrieve the complete effect
sequence for the purchase. Confirm the global funding claim has exactly one
owner, each Story transaction is canonical and final, parent transfers follow
the child royalty payment, entitlement mint is last, and delivery exists only
when the entire sequence is confirmed. Attach the before/after rows, canonical
receipts, audit events, repair commit or admin-action version, and final scan to
the incident.
