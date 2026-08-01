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
