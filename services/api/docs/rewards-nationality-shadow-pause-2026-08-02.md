# Nationality shadow collection pause

Status: owner-approved pause. Existing records must remain untouched until a
retention, deletion, disclosure, and access policy is approved.

## Production inventory

Read-only aggregate inventory captured at 2026-08-02 18:29 +04 from the
production control plane. No identifiers, nationalities, hashes, or source rows
were read into the report.

| Scope | Rows | Users | Date range | Providers |
| --- | ---: | ---: | --- | --- |
| `reward_claim_identity_evidence` shadow snapshots | 0 | 0 | none | none |
| Source `user_attestations` with `capability_key = 'nationality'` | 2 | 2 | 2026-05-06 16:07:08Z to 2026-05-26 17:01:17Z | Self |
| Selected reward identity bindings backed by nationality evidence | 0 | 0 | none | none |

The live shadow evaluator had not persisted any claim-level evidence before the
pause. The two source nationality attestations predate this shadow dataset and
remain governed by the identity-verification data lifecycle; this change does
not modify or delete them.

## Pause behavior

`REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED` is an explicit opt-in. Unset,
`false`, or any value other than the exact string `true` prevents nationality
evidence resolution and persistence without changing uniform reward accounting,
qualification, or settlement. Staging and production are explicitly configured
`false`.

Re-enabling collection requires an approved data policy and a reviewed config
change. Retain-versus-delete remains explicitly undecided.
