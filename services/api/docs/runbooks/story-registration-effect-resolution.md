# Story Registration Effect Resolution

Use this runbook for the high-severity ops alert
`story_registration_reconciliation_required`. The journal is deliberately
fail-closed: never recycle the owning finalize job until the prior transaction
has a proven outcome.

## Inputs

Collect the alert's community ID and asset ID, the production API base URL, and
the admin token. Keep the token in an environment variable; do not paste it
into incident notes or shell history.

Inspect the fenced journal row:

```bash
curl -sS \
  -H "x-admin-token: ${PIRATE_ADMIN_TOKEN}" \
  "${API_BASE_URL}/admin/debug/story-registration-effect?community_id=${COMMUNITY_ID}&asset_id=${ASSET_ID}"
```

Record `operation_id`, `chain_id`, `signer_address`, `status`, and
`provider_tx_ref` in the incident. Stop if the status is no longer
`reconciliation_required`; another operator or worker already changed it.

## Classify the Outcome

There are four valid outcomes:

1. **Receipt is pending or RPC reads disagree:** wait and investigate the RPC
   providers. Do not change the journal.
2. **Receipt succeeded:** use the successful-receipt action below. It verifies
   the journal's chain and signer, five canonical confirmations, the Story
   registry, IP/NFT IDs, metadata events and payload identity, license or
   derivative events, royalty vault, and runtime royalty configuration before
   changing state.
3. **Receipt reverted:** use the reverted-receipt action below. A canonical
   reverted receipt proves that retrying cannot duplicate the registration.
4. **No transaction was broadcast:** use the no-broadcast attestation only
   after checking signer history and provider traces across every configured
   RPC. A missing receipt by itself is not proof of no broadcast.

Every action writes a required `resolution_requested` control-plane audit
before its shard CAS. A successful CAS then writes `resolution_applied`. If the
second audit is absent after an interruption, the requested record and journal
state still describe exactly what happened.

## Successful Receipt

Build the recovery result from the receipt's canonical Story events. The API
rejects any mismatch; it does not trust these supplied values on their own. It
also reads the IP metadata URI and verifies its SHA-256 plus community, asset,
content hash, rights basis, and creator against the fenced journal request.

```bash
curl -sS -X POST \
  -H "content-type: application/json" \
  -H "x-admin-token: ${PIRATE_ADMIN_TOKEN}" \
  "${API_BASE_URL}/admin/debug/story-registration-effect/confirm-receipt" \
  --data-binary @story-registration-resolution.json
```

`story-registration-resolution.json` has this shape:

```json
{
  "community_id": "com_...",
  "asset_id": "asset_...",
  "operation_id": "sro_...",
  "provider_tx_ref": "0x...",
  "reason": "canonical receipt and Story events verified in incident INC-...",
  "result": {
    "storyIpId": "0x...",
    "storyIpNftContract": "0x...",
    "storyIpNftTokenId": "123",
    "storyIpMetadataUri": "ipfs://...",
    "storyIpMetadataHash": "0x...",
    "storyNftMetadataUri": "ipfs://...",
    "storyNftMetadataHash": "0x...",
    "ipRoyaltyVault": "0x...",
    "storyLicenseTermsId": "1",
    "storyLicenseTemplate": null,
    "storyRoyaltyPolicy": "0x...",
    "storyDerivativeParentIpIds": null,
    "storyRevenueToken": "0x...",
    "storyRoyaltyRegistrationStatus": "registered",
    "storyDerivativeRegisteredAt": null,
    "royaltyDistributionTxHash": "0x..."
  }
}
```

For a derivative, `storyLicenseTermsId` remains `null`,
`storyDerivativeParentIpIds` must contain the ordered parent IP IDs from the
receipt, and `storyDerivativeRegisteredAt` must be an ISO timestamp. Nullable
vault or distribution fields may be `null` only when the registration did not
create them.

## Reverted Receipt

This action independently reads the transaction and receipt, verifies the
journal's chain, signer, transaction hash, and a reverted outcome, then makes
the effect retryable.

```bash
curl -sS -X POST \
  -H "content-type: application/json" \
  -H "x-admin-token: ${PIRATE_ADMIN_TOKEN}" \
  "${API_BASE_URL}/admin/debug/story-registration-effect/confirm-reverted" \
  --data-binary "{
    \"community_id\": \"${COMMUNITY_ID}\",
    \"asset_id\": \"${ASSET_ID}\",
    \"operation_id\": \"${OPERATION_ID}\",
    \"provider_tx_ref\": \"${TX_HASH}\",
    \"reason\": \"canonical reverted receipt verified in incident ${INCIDENT_ID}\"
  }"
```

## Proven No Broadcast

Use this only when `provider_tx_ref` is null and independent signer history and
provider traces prove that no transaction was accepted.

```bash
curl -sS -X POST \
  -H "content-type: application/json" \
  -H "x-admin-token: ${PIRATE_ADMIN_TOKEN}" \
  "${API_BASE_URL}/admin/debug/story-registration-effect/confirm-no-broadcast" \
  --data-binary "{
    \"community_id\": \"${COMMUNITY_ID}\",
    \"asset_id\": \"${ASSET_ID}\",
    \"operation_id\": \"${OPERATION_ID}\",
    \"reason\": \"signer history and all provider traces checked in ${INCIDENT_ID}\"
  }"
```

## Resume and Close

After any action returns `ok: true`, recycle only the owning
`post_publish_finalize` job through `/admin/debug/community-job/recycle`. A
confirmed effect replays its stored result; a reverted or proven-no-broadcast
effect gets a new operation ID and retries registration. Confirm that the post
leaves processing and that the reconciliation alert clears. Attach both audit
event IDs and the final journal response to the incident.

Never resolve the shard with hand-written SQL. If an action rejects the
receipt or result, preserve the fail-closed state and escalate the mismatch.
