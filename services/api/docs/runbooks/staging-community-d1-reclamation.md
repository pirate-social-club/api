# Staging Community D1 Reclamation

This runbook defines the evidence and review required before deleting archived
staging smoke-community databases and returning their bindings to the D1 pool.
It does not authorize a reclamation by itself.

## Why this exists

A recorded staging schema scan from release run `30759252865` contained 1,055
live bindings and seven quarantined bindings. Production's corresponding fleet
contained 104 live bindings and one quarantined binding. The staging release
gate therefore really does contact roughly one thousand databases; this is not
the count of merely configured or empty bindings.

These counts are historical evidence, not current capacity. Always obtain a
fresh, read-only pool snapshot before planning a batch. Never infer live or free
counts from `wrangler.jsonc`, repository fixtures, or an earlier release scan.

Reclamation provides pool headroom and reduces the staging full-scan workload.
It does not replace the schema-attestation ledger fast path. The full scan
remains the release authority until that later phase is separately reviewed and
activated.

## Existing safety boundary

The staging-only `POST /admin/debug/staging-d1/reclaim` endpoint accepts at most
50 explicit community IDs. Without `apply: true` it is a dry run. Apply mode
also requires the literal confirmation returned by an invalid request.

For every ID, the endpoint requires all of the following:

- admin authentication and `ENVIRONMENT=staging`;
- a known smoke-community display name or description;
- control-plane community status `archived` or `deleted`;
- a routing row with a binding;
- a shard-pool row still mapped to the exact community;
- the pool generation observed immediately before decommission.

The shard then claims `(binding_name, community_id, version)` before touching
the target D1, drops the target's non-system tables, and releases only the
claimed generation. Reserved fixture bindings are refused. A crashed claim is
retryable with the original generation, and ordinary release cannot steal a
row marked `decommissioning`.

This protects execution; it does not discover candidates. Archive status alone
is not proof of disposability because users can unarchive ordinary communities.
Only recognized, intentionally ephemeral staging smoke communities are in
scope.

## Phase A: read-only inventory

Capture the following as one timestamped evidence bundle:

1. Live D1 pool rows with at least `binding_name`, `community_id`, `version`,
   `allocated_at`, `last_loaded_at`, `last_error`, and `released_at`.
2. Aggregate pool stats using the allocator's actual predicate: total,
   allocated, free, quarantined, and recent allocation rates.
3. Control-plane rows for every allocated community: status, display name,
   description, routing state, binding, and decommission timestamp.
4. The current list of reserved fixtures and persistent staging communities.

The bundle must be read-only and must record its query time and environment.
Raw remote output may contain identifiers, so keep it in the approved evidence
location rather than committing it blindly.

The checked-in inventory command performs these reads and has no apply mode:

```bash
rtk bun run admin:staging-d1-reclaim-inventory -- --output /tmp/staging-d1-reclamation-inventory.json
```

Run it through the staging Infisical environment. The evidence file is created
with mode `0600` and fails if the target path already exists.
The command prefers `CONTROL_PLANE_MIGRATOR_DATABASE_URL` and otherwise uses
the staging `CONTROL_PLANE_DATABASE_URL`; either value must be PostgreSQL.
For the pool read it prefers the dedicated D1 API token and otherwise uses the
caller's authenticated Wrangler session. Both paths execute the same SELECT.

Classify a row as a candidate only when all of these are true:

- the pool and routing rows agree on community and binding;
- the community is `archived` or `deleted`;
- its name or description matches the endpoint's checked-in smoke signatures;
- the binding is loaded, is not reserved, and is not already decommissioning;
- the routing row is not already decommissioned;
- no provisioning job for the community is queued or running;
- the ID is absent from the reviewed persistent-fixture denylist.

Any missing row, disagreement, unknown signature, active community, active job,
quarantine, error marker, or ambiguous state is an exclusion—not a reason to
guess.

The candidate artifact must include the observed pool `version` even though the
apply endpoint re-reads it. That makes a later drift review possible.

## Phase B: dry run and review

Submit explicit candidate IDs to the endpoint with apply omitted or false, in
batches of no more than 50. Save the response alongside the inventory.

Before apply, an operator other than the person who produced the inventory must
review:

- every row was accepted by the dry run;
- candidate IDs and bindings are unique;
- no reserved or persistent fixture appears;
- the inventory is recent enough that its lifecycle assumptions are credible;
- desired capacity is based on the fresh burn rate, not a hard-coded fleet
  estimate.

Use an operational headroom target, not a platform-limit claim. A reasonable
initial policy is the greater of 250 immediately free bindings or 30 days of
capacity at the faster observed 24-hour/seven-day burn rate. If the current
pool cannot meet that target safely, refill or add another shard worker rather
than broadening candidate eligibility.

## Phase C: supervised canary

Applying is irreversible: the community D1 tables are dropped. It requires a
separate explicit authorization after the evidence review.

Start with one candidate. Apply the exact dry-run ID using the required
confirmation, then verify all of the following before continuing:

- the response reports success and the number of tables dropped;
- the pool row is tenant-free and its generation advanced as expected;
- the released binding enters quarantine and is not immediately allocatable;
- the routing row is decommissioned and the community is deleted;
- reads for that community fail closed;
- pool statistics change by exactly one after quarantine semantics are
  accounted for;
- provisioning and release health remain green.

After the quarantine window, provision one new disposable smoke community and
confirm allocator reuse, snapshot load, routing, and read/write behavior. Do
not use a persistent fixture for this test.

## Phase D: bounded batches

Proceed only after the canary and reuse test pass. Apply batches of at most 25,
despite the endpoint's maximum of 50, and stop between batches to recapture pool
stats and inspect every result.

Stop immediately on any conflict, target-not-empty anomaly after a reported
release, routing/pool disagreement, unexpected table count, health regression,
or result count mismatch. Do not bypass a failed generation fence. Re-inventory
and review the new state.

Finish when the reviewed headroom target is met; do not delete every eligible
row merely because it is eligible. Record before/after allocated, free,
quarantined, and live-scan counts, plus the release-scan duration once a later
release supplies it.

## Recovery boundaries

There is no data rollback after a successful decommission. Recovery means
provisioning a new empty community database, not restoring the deleted smoke
data. This is why candidate identity—not table emptiness—is the primary safety
decision.

If a request fails after the routing row is marked decommissioned, retry the
same community through the reviewed endpoint. The shard's claimed-generation
path is designed to resume an interrupted decommission. Do not manually clear
`last_error`, edit `version`, or issue raw D1 deletes.

If the pool release succeeded but the response was lost, the same request may
return an idempotent success only when the target is demonstrably empty and the
pool generation is exactly the released retry generation.

## Follow-up automation

Candidate discovery should become a read-only report that implements the exact
classification above and emits a digest-bound artifact. It must not gain an
apply flag. The existing endpoint remains the reviewed execution boundary.

Separately, the attestation-ledger work should remove the full scan from normal
releases once all mandatory policy digests are present and the fast path is
approved. Reclamation is useful capacity hygiene, not a substitute for that
control-plane change.
