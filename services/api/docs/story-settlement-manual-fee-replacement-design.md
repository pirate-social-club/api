# Story settlement manual fee replacement — testnet design

Status: implementation gate for the Aeneid recovery action. This document authorizes no mainnet
configuration and no automatic fee bumping.

Related design: `story-settlement-broadcast-journal-design.md`
Related runbook: `runbooks/story-settlement-coordinator-operations.md`

## Purpose

Recover a coordinator transaction that is positively observed as pending but is not progressing
because its EIP-1559 fees are too low. The operator action signs one policy-bounded transaction with
the same signer, chain, nonce, destination, value, calldata, and gas limit. Only fee fields change.

This is not an arbitrary transaction endpoint, a fresh business effect, or an automatic fee policy.

## Invariants

1. Admission is disabled before a replacement is requested and remains disabled until one candidate
   is final and the coordinator backlog is healthy.
2. The original transaction must be positively observed as `pending`. `absent`, RPC failure, mined,
   final, reverted, or non-canonical observations reject the request.
3. Signer, chain, nonce, target, value, calldata, and gas limit are copied from the durable original
   journal. The request cannot supply them.
4. Both replacement fee fields strictly exceed the active candidate, priority fee never exceeds max
   fee, and both remain within the deployed policy caps.
5. Signed replacement bytes are parsed, signer-recovered, field-checked, hashed, and durably inserted
   before any broadcast.
6. Every candidate hash remains durable. Updating a single `transaction_hash` field and forgetting the
   original is prohibited because either candidate may win the nonce.
7. Broadcast and reconciliation use only exact persisted bytes. No retry path signs again.
8. At most one non-terminal replacement generation exists for a step. A later generation requires a
   new operator authorization after the prior generation is terminal.
9. Finalization follows the first canonical successful candidate to reach the plan's persisted
   finality policy. A successful sibling is then classified `superseded`; it is never broadcast again.
10. A reverted winning candidate fails the business step. The coordinator never creates another
    generation automatically.
11. The shard mirror reports the actual winning transaction hash and receipt, while retaining the
    original and replacement hashes in coordinator evidence.
12. Every request records the operator credential, actor, incident/authorization reference, old and
    new fee fields, generation, candidate hash, and final disposition.

## Durable model

Add `story_settlement_transaction_candidates` inside the wallet-scoped Durable Object:

- `candidate_ref` — bytes32 primary key derived from step, generation, fees, and authorization;
- `step_ref`, `generation`, `kind` (`original` or `fee_replacement`);
- `parent_candidate_ref` for the candidate being replaced;
- immutable signer domain, nonce, target, value, calldata digest, and gas limit evidence;
- max fee and priority fee;
- signed bytes and transaction hash;
- state: `prepared`, `broadcast`, `mined`, `confirmed`, `reverted`, `superseded`, or
  `reconciliation_required`;
- receipt block identity/status, attempt timestamps, operator identity, and authorization reference.

The existing step row remains the business-call identity and ordering record. Add
`winning_candidate_ref` only after a candidate is canonical and final. Plan/step results derive the
reported transaction hash and receipt from that winner. Existing coordinator objects receive an
idempotent migration that imports their current signed bytes/hash as generation zero `original`
candidates; import must verify `hash == keccak256(bytes)` and must never synthesize missing evidence.

If legacy evidence cannot be verified, the step enters `reconciliation_required` and replacement is
blocked pending incident review.

## Request protocol

The scoped operator route accepts only:

- plan ref and step ref;
- expected step version and expected active candidate hash;
- new max fee and priority fee;
- authorization/incident reference.

The coordinator then:

1. verifies operator scope and exact version/hash fencing;
2. verifies no unresolved nonce repair or replacement exists;
3. observes the active candidate as pending and checks the signer pending nonce still includes it;
4. validates strict fee increase and deployed caps;
5. signs using fields copied from the journal;
6. independently parses and verifies the signed bytes;
7. inserts the `prepared` candidate and audit evidence transactionally;
8. schedules the alarm and returns `202` without broadcasting in the RPC handler.

The alarm broadcasts exact bytes, then reconciles all non-terminal candidates for that step. It does
not assume the newest candidate wins.

## Reconciliation cases

| Evidence | Action |
| --- | --- |
| Both hashes pending | wait; do not create another generation |
| Original mined, replacement pending/absent | stop replacement broadcast, reconcile original to finality |
| Replacement mined, original pending/absent | stop original rebroadcast, reconcile replacement to finality |
| One successful and final | set winner, confirm business step, supersede siblings |
| Winning candidate reverted | mark candidate and business step reverted; page |
| Both absent and nonce unused | exact-byte rebroadcast newest prepared/broadcast candidate only |
| Both absent and nonce consumed | `reconciliation_required`; never guess the winner |
| Block identity changes before finality | `reconciliation_required`, retain both observations, page |
| RPC ambiguity | retain current states and retry observation; never sign |

## Required tests

- request rejects every state except positively pending;
- request fields cannot alter business-call fields or gas limit;
- fee monotonicity and policy caps;
- signed-byte parsing/recovered signer/hash equality;
- crash after sign before persist causes no broadcast;
- crash after persist before broadcast resumes with exact bytes;
- crash after broadcast before state write re-observes both hashes;
- original wins, replacement wins, replacement reverts, and nonce consumed by unknown hash;
- original mines during replacement signing;
- duplicate request and concurrent operators yield one generation;
- mirror exposes the actual winner;
- alarm eviction at every boundary;
- route auth/scope/audit logging;
- production/mainnet configuration remains absent.

## Staging proof

After implementation review, use Aeneid only:

1. freeze admission and select a journaled transaction positively pending with deliberately bounded
   low fees from a reviewed staging drill;
2. inspect and peer-approve the candidate evidence;
3. request one bounded replacement through the scoped route;
4. prove persist-before-broadcast, same nonce/business fields, higher bounded fees, final winner,
   sibling disposition, mirror convergence, and alert delivery;
5. retain hashes, block identities, policy versions, audit references, and deployed commits;
6. leave admission disabled until review closes the incident.

No `cast send`, direct signer use, Durable Object storage edits, or mainnet transaction is permitted.
