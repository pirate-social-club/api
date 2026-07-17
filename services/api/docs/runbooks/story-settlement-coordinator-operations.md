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

The latest staging drill preflight and its honest no-candidate result are recorded in
`../evidence/story-settlement-nonce-repair-drill-2026-07-17.md`. That scan does not satisfy M4; use
the evidence checklist there when an eligible staging nonce exists.

Use only for a step that is durably `reserving`, has a reserved nonce, has no
signed transaction or transaction hash, and cannot ever become a valid plan
step. A rights hold alone freezes admission and is not proof of abandonment.

1. Prove the nonce is unused across every provider and explorer. Confirm the
   signer latest nonce is not greater than it and that no pending transaction
   occupies it.
2. Confirm no lower unresolved nonce or existing repair exists. A repair blocks
   all later allocation by design.
3. Create an incident-scoped authorization reference and bounded reason code.
4. Use an active operator credential whose only scope is
   `story:settlement:repair`. Issue it with `scripts/operator-credentials.ts`
   and store it under `PIRATE_STORY_SETTLEMENT_OPERATOR_CREDENTIAL`; never
   print the credential.
5. POST the reviewed evidence to
   `/operator/story-settlement/nonce-repairs`:

   ```json
   {
     "plan_ref": "0x...",
     "step_ref": "0x...",
     "expected_version": 3,
     "reason_code": "rights_hold",
     "authorization_ref": "INC-2026-0716"
   }
   ```

   The route authenticates the dedicated scope, resolves the exclusive signer
   domain server-side, prefixes the durable authorization reference with the
   operator credential ID, and calls `requestAbandonedNonceRepair`. A `202`
   means the request was journaled, not that the repair is final.
6. The coordinator journals and signs a zero-value self-transaction at the
   abandoned nonce. Verify its recovered signer, nonce, destination, zero
   value, empty calldata, hash, canonical receipt, and finality.
7. Confirm the repair reaches `confirmed`, the abandoned step becomes
   `replaced`, nonce allocation resumes, and no unrelated plan changed.

## Targeted purchase reconciliation

Use this when a purchase already has a coordinator plan reference but its shard
mirror or local delivery has not advanced, especially for a test or quarantined
community that is deliberately absent from active-community cron enumeration.

1. Confirm new admission is disabled and record the community, quote, purchase,
   plan, funding receipt, coordinator version, and every known transaction hash.
2. Prove the buyer funding effect is confirmed exactly once and that the request
   will target the original quote. Never create a new quote or funding transfer.
3. With the dedicated `story:settlement:repair` operator credential, POST:

   ```json
   {
     "community_id": "cmt_...",
     "quote_id": "qte_...",
     "authorization_ref": "INC-..."
   }
   ```

   to `/operator/story-settlement/purchase-reconciliations`.
4. A `202` means the existing coordinator plan remains pending; repeat only the
   same scoped action after its alarm/reconciliation delay. A `200` means the
   plan was confirmed and local purchase delivery finalized.
5. Verify the coordinator reused the existing plan, nonce space, signed bytes,
   and funding receipt. Confirm no legacy Story broadcast path ran.

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
6. Run the staging crash-matrix canary with a test price below $0.20. The
   unconditional WIP wrap consumes native IP 1:1 with the payout; the initial
   0.25 IP reserve must retain gas headroom. Enable only the single approved
   staging community after every gate passes.
7. Retain the old key only for explicit legacy incident disposition until the
   legacy path is retired. Any transaction from the new address without a
   coordinator plan is a security incident.

## Policy rotation

Never bump fee/finality policy versions mid-flight. Disable admission, drain
all plans, verify zero backlog and repairs, deploy new values plus a new version
atomically, run a non-value preflight/canary, and only then resume admission.
See `docs/story-settlement-coordinator-policy-v1.md`.

## Staging alert-sink probe

Before canary admission, POST a unique incident-style `authorization_ref` to
`/operator/story-settlement/alerts/synthetic` with the same scoped operator
credential. The route is structurally disabled outside `ENVIRONMENT=staging`.
A `202 {"delivered":true}` proves the configured alert sink accepted the
high-urgency synthetic coordinator alert; independently verify receipt in the
destination mailbox. Do not reuse the reference because scheduled-alert
deduplication is intentional.

## Legacy stuck effects

Legacy failed parent transfers do not self-heal after API PR #534. Start with
`docs/runbooks/purchase-settlement-effect-resolution.md`: run the read-only
stuck-effects lister, collect multi-provider transaction and signer-nonce
evidence, and use a reviewed manual re-settle generation only after positive
proof of non-broadcast. Never route a legacy effect through coordinator nonce
repair or infer non-broadcast from an SDK error class.
