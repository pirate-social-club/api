# Story settlement coordinator operations

This runbook covers coordinator signer rotation, abandoned nonce repair, and
manual fee replacement. None of these procedures authorizes enabling Story
settlement admission. Every value-moving action requires an incident, a second
operator, preserved chain evidence, and an audited operator tool. Never repair
coordinator state with hand-written SQL or direct Durable Object storage edits.

## Before any action

1. Disable new admission and confirm the exact deployed configuration reports
   it disabled.
2. Record chain ID, signer address, coordinator name, plan, step, nonce, signed
   transaction hash, local state/version, latest nonce, pending nonce, and all
   provider transaction/receipt evidence.
3. Verify every RPC reports the expected `eth_chainId`. Compare canonical block
   hashes at the plan's recorded finality policy.
4. Require a peer to independently reproduce the evidence and approve the
   bounded action.

## Abandoned nonce repair

Use only for a step that is durably `reserving`, has a reserved nonce, has no
signed transaction or transaction hash, and cannot ever become a valid plan
step. A rights hold alone freezes admission and is not proof of abandonment.

1. Prove the nonce is unused across every provider and explorer. Confirm the
   signer latest nonce is not greater than it and that no pending transaction
   occupies it.
2. Confirm no lower unresolved nonce or existing repair exists. A repair blocks
   all later allocation by design.
3. Create an incident-scoped authorization reference and bounded reason code.
4. Invoke the audited action that calls
   `requestAbandonedNonceRepair({planRef, stepRef, expectedVersion,
   reasonCode, authorizationRef})`. If that operator action is not deployed,
   stop; direct RPC/storage improvisation is prohibited.
5. The coordinator journals and signs a zero-value self-transaction at the
   abandoned nonce. Verify its recovered signer, nonce, destination, zero
   value, empty calldata, hash, canonical receipt, and finality.
6. Confirm the repair reaches `confirmed`, the abandoned step becomes
   `replaced`, nonce allocation resumes, and no unrelated plan changed.

## Manual fee replacement

V1 does not create automatic replacements. Use this only for a journaled
transaction that remains pending beyond the broadcast-age alert and whose
nonce is still occupied by that exact hash.

1. Verify the original transaction is pending, not absent, mined, replaced, or
   reorged. Confirm its complete signed fields against the journal.
2. Stop admission and drain all earlier nonces. Later plans remain blocked.
3. Choose reviewed fees within the incident-specific treasury ceiling. The
   replacement must preserve signer, chain, nonce, target, value, calldata,
   gas limit, call identity, and plan/step identity. Only fee fields may change.
4. Use a purpose-built audited replacement action that persists the new signed
   bytes and replacement hash before broadcasting, while retaining the old
   hash. Until that action exists, do not replace manually with `cast`, a
   wallet, or the legacy cancel script.
5. Track both hashes. Confirm exactly one canonical success. Any conflicting
   receipt or nonce consumption moves the step to reconciliation-required and
   pages an operator; it never authorizes another signature.

## Signer rotation

The coordinator key is `STORY_COORDINATOR_SIGNER_PRIVATE_KEY`; the matching
public guard is `STORY_COORDINATOR_SIGNER_ADDRESS`. It must never be copied to
the legacy `MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY` role.

1. Disable admission and drain the old signer to zero nonterminal plans and
   zero unresolved repairs. Record latest/pending nonce equality.
2. Generate the fresh key through the approved secret workflow without
   printing it. Derive and independently verify the address. Store the secret
   and expected address under the coordinator-only names.
3. Fund native IP for every canary wrap plus capped gas and the enforced
   reserve. Do not count existing WIP toward the native reserve.
4. Add the address to native-balance, WIP-solvency, nonce-gap, backlog-age, and
   reconciliation-age monitoring before admission.
5. Deploy with admission still disabled. Verify the application derives the
   new address, the RPC chain, policy versions, and wallet-scoped DO name.
6. Run the staging crash-matrix canary. Enable only the single approved staging
   community after every gate passes.
7. Retain the old key only for explicit legacy incident disposition until the
   legacy path is retired. Any transaction from the new address without a
   coordinator plan is a security incident.

## Policy rotation

Never bump fee/finality policy versions mid-flight. Disable admission, drain
all plans, verify zero backlog and repairs, deploy new values plus a new version
atomically, run a non-value preflight/canary, and only then resume admission.
See `docs/story-settlement-coordinator-policy-v1.md`.

## Legacy stuck effects

Legacy failed parent transfers do not self-heal after API PR #534. Start with
`docs/runbooks/purchase-settlement-effect-resolution.md`: run the read-only
stuck-effects lister, collect multi-provider transaction and signer-nonce
evidence, and use a reviewed manual re-settle generation only after positive
proof of non-broadcast. Never route a legacy effect through coordinator nonce
repair or infer non-broadcast from an SDK error class.

