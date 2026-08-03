# Reward identity binding invariants

Reward identity bindings are document-selection records, not standalone proof
of current eligibility. Any claim or shadow evaluator must resolve a binding by
joining `reward_identity_bindings.identity_nullifier_id` to an
`identity_nullifiers` row whose status is `active`; querying only
`reward_identity_bindings WHERE status = 'active'` is insufficient because a
revoked nullifier can make a binding ineligible before its lifecycle row is
superseded.

Repeating selection of the already-bound nullifier is idempotent: it preserves
the binding id and `selected_at`. A different eligible nullifier is a genuine
reselection and atomically supersedes the old binding before inserting the new
active row.

## Shadow claim evaluation

The shadow evaluator reads nationality transiently from the canonical identity
records. It follows this chain exactly:

`active binding -> active Self nullifier for the same user -> accepted,
unrevoked nationality attestation whose source_identity_nullifier_id is that
nullifier`.

The resolver never reads `verification_capabilities_json.nationality`. That
account projection is shared by providers and can be overwritten by a proof
from a document other than the one selected for rewards.

Rewards persists only the resulting `reward_nationality_decisions` row: a
versioned tier/default result or coarse failure outcome, retryability, campaign
terms version, evaluator version, and lifecycle timestamps. It does not copy
nationality, nullifiers, attestations, verification sessions, bindings, or
provider provenance into the rewards domain.

Outcome and retryability are separate fields. Missing selection and missing
evidence are retryable; a binding/nullifier mismatch and conflicting bound
evidence are terminal for that qualification. Retryable rows may advance when
the user supplies evidence. Resolved and terminal rows are immutable decision
snapshots.

Every row carries an `evaluator_version`. A future resolver version may advance
a retryable row and replace that version, but the database conflict predicate
keeps resolved and terminal decisions frozen with the evaluator version that
produced them.

Evidence expiry is intentionally not a shadow-evaluation filter. Expiry means
the user must re-prove before making a new document selection; it does not
revoke an existing selection or its accepted evidence. Revocation, nullifier
status, provider/user mismatch, and conflicting bound nationalities still fail
closed.

Shadow evaluation runs only after the uniform reward transaction finishes and
its errors are non-blocking. It never branches credit flow, reserves budget, or
updates campaign, contribution-lot, reservation, reward-event, claim, pending
qualification, or user-day accounting. A successful tier payout test must not
exist while the tier-funding block remains in force.
