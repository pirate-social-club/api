# HNS complete-recovery audit — 2026-08-09

## Scope

This audit covers Handshake roots attached to communities. Spaces namespaces are explicitly out of scope.

The objective is stronger than ownership approval: every active HNS community should have a signed HNS import, a matching parent DS, a validating authoritative DNSSEC chain, fresh observer evidence, and an explicit canonical-routing activation before it appears in the public native-root registry.

## Production snapshot

The control-plane inspection was read-only. It used a read-only transaction and did not reset sessions, update roots, or publish wallet transactions.

At the inspection time, exactly three HNS roots were attached to active communities:

| Audit alias | Ownership / import state | Delegation state | Canonical activation | Public native registry | Required action |
| --- | --- | --- | --- | --- | --- |
| `.dankmeme` | Verified approval predates import-payload persistence; an unrelated newer challenge exists but is not the community pending session | Secure, matching parent DS and live DNSKEY, authoritative DNSSEC valid | Enabled | Included | None. Live cryptographic evidence proves setup complete; do not rewrite the wallet resource or clear the detached challenge merely to tidy it. |
| legacy-approved root | Current verified approval predates signed HNS import | Unsecured; parent DS does not match a live DNSKEY and authoritative DNSSEC does not validate | Disabled | Excluded | Start a new same-root HNS import. Preserve the old approval until the new import verifies. |
| secure unactivated root | Verified approval predates import-payload persistence, but the live HNS resource already contains the working Pirate delegation | Secure, matching parent DS and live DNSKEY, authoritative DNSSEC valid | Disabled | Incorrectly included before this patch | Deploy the registry gate fix, wait for three qualifying observations, then activate. Do not re-import or reset it. |

All other HNS session rows were expired, abandoned, smoke-test, or otherwise not attached to an active community. They need no mutation unless an operator intentionally revives the corresponding community.

The pre-fix live check at approximately 07:12 UTC observed API `4798dc4...` and Web `14b91b0...`. The public native registry still contained `.dankmeme` and the secure unactivated root, while the legacy-approved root remained excluded. A later audit must record its own version pair and timestamp rather than assuming this snapshot is current.

## Defect 1: public routing bypassed canonical activation

`public-namespaces.ts` evaluated the root delegation read model but checked only `authenticatedRoutingAllowed`. That predicate proves that current DNSSEC evidence is healthy and that no availability or hard-deny policy is blocking it. It does not prove that the root passed the manual activation gate.

The read model deliberately exposes `canonicalRoutingEligible` separately. Activation is allowed only after all of these conditions hold:

- an active HNS verification is attached to an active community;
- the root is not hard-denied;
- the latest three parent observations all succeeded and are secure;
- every observation is no more than 15 minutes old;
- the three observations span at least 10 minutes;
- every observed RRSIG has more than 30 minutes remaining.

The route now requires both `authenticatedRoutingAllowed` and `canonicalRoutingEligible`. The single-root endpoint and the list endpoint share this predicate. A regression test proves that a fresh secure root with `canonical_routing_eligible = 0` receives 404 and is excluded from the list.

The Web native-route claim now independently requires:

- `pirate_web_routing_allowed = true`;
- `canonical_routing_eligible = true`;
- `routing_hard_denied != true`.

This is defense in depth. The API remains the routing authority.

## Defect 2: no recovery bridge for legacy approved roots

Starting a fresh verification for the same root was already safe at the API layer:

1. A new session gets a fresh signed HNS import plan and a root-scoped import lock.
2. The existing verified primary remains attached while the owner publishes the replacement HNS resource.
3. Completing the new session creates a new verification ID.
4. The community provisioning service accepts a primary replacement only when the old and new verifications identify the same namespace root.
5. The repository replaces the primary binding atomically and supersedes the old binding.

The Web did not use that primitive. When the old primary was still verified, every newly completed verification was classified as a mirror. A legacy approval therefore stayed primary even after the signed import completed.

The fix has three parts:

1. The community namespace read model reports `hns_setup_status` as `legacy_import_required` or `setup_complete`. A signed import proves completion, and a currently secure delegation with matching parent DS/live DNSKEY plus valid authoritative DNSSEC is accepted as stronger compatibility evidence for roots that predate import-payload persistence.
2. A legacy HNS primary gets a **Complete HNS setup** action. It preselects the already-attached root and starts the normal HNS import flow. It does not detach or invalidate the current route.
3. When the new verification completes, the Web promotes it to primary if its family and normalized root match the current primary, even when the old verification is still fresh. A different root remains a mirror.

No special reset endpoint and no destructive database rewrite are needed.

## Owner and operator sequence

Deployment order matters:

1. Deploy the API registry gate and `hns_setup_status` response first.
2. Confirm that every root with `canonical_routing_eligible = 0` is absent from both `GET /public-namespaces` and `GET /public-namespaces/{root}`.
3. Deploy the Web recovery action.
4. For each `legacy_import_required` primary, the owner selects **Complete HNS setup**, reviews the full replacement resource, signs and broadcasts it from the owner wallet, and resumes the pending session until verified.
5. Confirm that the new verification became the primary and the prior same-root binding became superseded. The conventional `pirate.sc` community route must remain available throughout.
6. Let the root observer collect the required secure window. Do not activate after one successful check.
7. Activate only through the audited command after the gate accepts the evidence:

   ```bash
   rtk bun run admin:hns-root-activate --root ROOT --actor operator --reason "three-cycle HNS activation review"
   ```

8. Re-read the community attachment, root state, three evidence rows, public registry entry, and native route. Record the deployed API/Web version pair and evidence observation IDs.

The platform can generate and validate the resource plan, but it cannot legitimately publish the owner-wallet HNS transaction on the owner's behalf. That wallet signature is the only owner-dependent part of the repair.

## Audit queries and invariants

An independent audit should join active community bindings to their verification source sessions and root state. The important fields are:

```sql
SELECT
  c.community_id,
  nv.namespace_verification_id,
  nv.normalized_root_label,
  nv.status AS verification_status,
  nv.expires_at AS verification_expires_at,
  source.challenge_kind,
  source.challenge_payload_json,
  state.canonical_routing_eligible,
  state.routing_hard_denied,
  observation.outcome,
  observation.observed_delegation_security,
  observation.parent_ds_matches_live_dnskey,
  observation.authoritative_dnssec_valid,
  observation.observed_at,
  observation.earliest_rrsig_expires_at
FROM communities c
JOIN community_namespace_bindings binding
  ON binding.community_id = c.community_id
 AND binding.status = 'active'
 AND binding.namespace_role = 'primary'
JOIN namespace_verifications nv
  ON nv.namespace_verification_id = binding.namespace_verification_id
LEFT JOIN namespace_verification_sessions source
  ON source.namespace_verification_session_id = nv.source_namespace_verification_session_id
LEFT JOIN hns_root_delegation_state state
  ON state.normalized_root_label = nv.normalized_root_label
LEFT JOIN hns_root_parent_observations observation
  ON observation.parent_observation_id = state.last_parent_observation_id
WHERE c.status = 'active'
  AND nv.family = 'hns';
```

For every active HNS primary, assert all of the following:

- setup completion is proved by signed-import provenance or by current matching parent DS/live DNSKEY plus valid authoritative DNSSEC for pre-provenance roots;
- the community has no unresolved pending import session after successful replacement;
- the active primary binding points to the new verification;
- parent DS matches a live DNSKEY;
- authoritative DNSSEC validates;
- the successful observation is fresh and its signatures are not near expiry;
- three qualifying observations exist before canonical activation;
- hard deny is false;
- native public registry membership is equivalent to healthy authenticated routing **and** canonical activation;
- the conventional community route remains HTTP 200 independently of native activation.

## Verification performed in the change worktrees

- API focused tests: 17 passed, including legacy/import provenance classification, secure pre-provenance compatibility, and canonical-registry withholding.
- Web focused tests: 15 passed, including the legacy upgrade action, HNS-only same-root primary promotion, unchanged Spaces behavior, unrelated-root mirror behavior, and canonical native-route withholding.
- API focused package check passed after installing the worktree and its local shared package from their pinned lockfiles.
- Web safe typecheck reached one unrelated karaoke contract error after the HNS error was corrected when run against the established dependency tree. A fresh worktree install subsequently omitted multiple declared packages despite reporting success, so CI should supply the authoritative full Web typecheck before merge.
