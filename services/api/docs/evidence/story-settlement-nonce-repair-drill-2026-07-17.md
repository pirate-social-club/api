# Story settlement nonce-repair drill evidence — 2026-07-17

Status: **not executed; M4 remains open**.

Environment: staging / Story Aeneid chain 1315 / Base Sepolia funding chain 84532.

## Intended drill

Exercise the scoped `/operator/story-settlement/nonce-repairs` action against a genuinely abandoned
coordinator step, then prove the journaled zero-value self-transaction consumes exactly the reserved
unused nonce, reaches finality, marks the abandoned step replaced, and releases later allocation.

The governing runbook permits repair only when all of these are true:

- the step is durably `reserving` or eligible `failed_prebroadcast`;
- it has a reserved nonce;
- it has no signed bytes or transaction hash;
- the business step can never become valid;
- the nonce is unused across providers and no pending transaction occupies it;
- no lower unresolved nonce or active repair exists;
- admission is disabled;
- an independent second operator reproduces the evidence and approves the action.

## Read-only preflight performed

The maintained diagnostic was run against staging with its default 30-minute stale cutoff:

```text
scripts/list-stuck-story-settlement-effects.ts --env staging
```

It issued only community D1 `SELECT` statements and JSON-RPC reads. Result:

```json
{
  "mode": "read_only",
  "environment": "staging",
  "expected_chain_ids": {
    "funding": 84532,
    "story": 1315
  },
  "cutoff": "2026-07-17T19:19:28.616Z",
  "databases_scanned": 281,
  "scan_complete": true,
  "database_errors": [],
  "effects": []
}
```

No stale submitted buyer-funding, royalty-payment, parent-transfer, or entitlement-mint effect was
found. Consequently there was no plan/step/nonce evidence that could satisfy the repair runbook.

## Decision

No operator credential was issued and no repair request, signature, or transaction was created.
Manufacturing a gap by editing Durable Object storage, hand-reserving a nonce, cancelling a healthy
step, or broadcasting directly would invalidate the safety proof and is prohibited.

This result demonstrates a clean fleet scan, not a successful nonce-repair drill. Gate M4 remains
open.

## Safe path to complete M4

The executable path is a **purpose-built staging drill harness**. It targets one exact
`community_id:quote_id` in a throwaway staging community, drives that purchase through the normal
admission path, reserves a real signer nonce, and intentionally terminates before signing. It
exposes no arbitrary transaction or storage mutation capability. The target must be structurally
ignored outside staging and removed after the drill.

The harness itself needs state-machine tests, fault injection, exclusive-signer/nonce fencing,
admission-disabled enforcement, and an explicit maximum gas budget.

Waiting for a naturally eligible incident is not an executable alternative while admission is
disabled: without admission no plan can reserve, and therefore abandon, a nonce.

## Evidence required for eventual completion

- exact deployed API commit and coordinator version;
- admission-disabled proof;
- plan ref, step ref, state/version, reserved nonce, and absence of signed bytes/hash;
- multi-provider chain/latest/pending nonce and transaction evidence;
- independent operator approval;
- scoped credential ID and immutable authorization reference, never the secret;
- repair call identity, persisted signed hash, recovered signer, nonce, self-destination, zero value,
  and empty calldata;
- canonical receipt and finality;
- abandoned step `replaced`, repair `confirmed`, allocation resumed;
- durable audit/alert evidence and proof no unrelated plan changed.
