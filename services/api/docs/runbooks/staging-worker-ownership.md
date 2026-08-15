# Staging worker ownership

`pirate-api-staging` is a single shared mutable fixture. Several people and agent
sessions deploy to it, and a deploy replaces whatever bundle was there. Two
sessions deploying different bundles has repeatedly produced false test results
for both — each one measuring the other's code without knowing it.

This file is the coordination ledger. It lives in the repo, not in any one
person's notes, because a ledger that only one participant can read does not
coordinate anything.

## Before you deploy

1. Read the "Current holds" section below.
2. If someone holds staging, wait or coordinate with them. Do not deploy over an
   active hold.
3. If staging is free, add a hold entry in the same commit or PR as whatever
   work prompted the deploy (or as its own one-line commit). Record:
   - who holds it (person, session, or task)
   - the SHA you are deploying
   - when the hold starts
   - what you are measuring, so someone else can judge whether their deploy
     would invalidate it
4. Release the hold when finished, and say what staging is left on.

A hold is a claim about a shared resource, not a lock. Nothing enforces it. It
works only if entries are added before deploying and removed after.

## Two facts that surprise people

**A web release redeploys the staging API.** Every `release.yml` run's "Deploy
staging" job deploys `pirate-api-staging` at the current
`web/.github/release-refs/api.sha`. A manual staging deploy therefore survives
only until the next web release — in practice sometimes minutes. Re-check
`/__version` at the moment you collect evidence, not just after deploying.

**The version you deployed is not always the version your evidence ran on.**
Because of the above, evidence collected minutes after a deploy may come from a
different bundle. If the running SHA is a superset of yours, conclusions usually
still hold; verify ancestry rather than assuming:

```
git merge-base --is-ancestor <your-sha> <running-sha>
```

## Stamped deploy

From `services/api`, use the package deploy command. It routes through
`scripts/deploy-with-version.ts`, which stamps compile-time provenance:

```
rtk bun run deploy -- --env staging
```

Do not invoke `wrangler deploy` directly. A direct invocation bypasses both the
source checks and compile-time version stamping. The karaoke runtime is an
immutable GitHub Packages dependency, so a sibling Web checkout is neither read
nor validated during deployment. If the deploy shell must install dependencies
first, provide `NODE_AUTH_TOKEN` with `read:packages` as documented in the API
README.

Then confirm with
`curl -s https://api-staging.pirate.sc/__version`. Verify `git_sha`,
`git_ref`, `karaoke_scoring_version`, and `karaoke_runtime` package provenance
before collecting evidence.

## Reading the scheduler on staging

Staging D1 latency is far higher than production, and `process_community_jobs`
routinely runs 3-5 minutes. Consequences worth knowing before you diagnose
anything:

- The 30s batch deadline only stops *starting* jobs. It never cancels a job
  already in flight, so one slow job holds the batch — and the lease — for its
  full duration.
- The scheduler lease (`ScheduledCronLockDO`) has a 120s TTL, does not renew,
  and self-heals: the next acquirer compares the stored expiry against its own
  clock. A lease cannot be "stuck past its TTL" without clock skew.
- Therefore repeated `[scheduled] lease held by another invocation — skipping
  batch (0 jobs started)` lines are normal under load. Jobs run in bursts. Ticks
  that skip are not evidence that anything is broken.
- A gate that depends on a cron job needs a 10-15 minute window and a direct
  database check of the resulting rows. Do not judge it from tick logs.

## Current holds

- **RESOLVED — 2026-08-15T08:37:14Z — `lit_rewards_cutover_session`** — The
  prepared Lit configuration was reverted to the EOA settlement backend in API
  `cd692adff699803864705d53182a78e0f29b3844`. A read-only Base Sepolia
  preflight confirmed the deployed vault's settlement operator and the
  Infisical staging signer both resolve to the configured EOA. Staging remains
  on `f6f61fbd31a22d65eb526375ec78d607260b5f8d` until the explicitly scoped
  remediation deploy below; no Lit cutover or production change is authorized.

- **RELEASED — 2026-08-15T09:17:09Z — `fill_blank_eoa_restore`** — User-authorized
  deployment completed at merged API `9f79104d9b7eb8c507581465006378ea104df011`.
  `/__version` confirms that SHA, `source_state: clean`, and karaoke runtime
  `0.2.2`; Wrangler's deployment bindings show the staging settlement backend
  is `eoa_vault`. Production was not changed. The staging hold is released;
  no canary is authorized by this entry.

## Hold history

Keep entries short. Delete them once they are no longer useful context.

- **2026-08-06** — Rewards pending-expiry acceptance passed on API
  `62cb3fca5` (main fix `440ae3101`). One pre-deploy reconciler invocation
  recreated the expired fixture's 70-cent exposure after deployment; the fixed
  worker deleted it on its next pass, then four consecutive one-minute samples
  stayed at zero exposure with no reservation or credit. Staging was left on
  `62cb3fca5`; production was untouched.

- **2026-08-03** — Nationality shadow validation completed on Web-pinned API
  `6241fb92c`. Two genuine historical staging qualification events produced
  `resolved_default`/resolved and `nationality_evidence_missing`/retryable
  decisions at evaluator `nationality_binding_v1`; lifecycle deltas were exactly
  180 and 30 days. Reward events/reservations/payout effects stayed at
  4/4/7 rows and 400/400/450 cents. Reversible Self fixtures were exactly
  cleaned, the pre-existing Very identity remained active, and staging was left
  on `6241fb92c` with no manual Worker deploy.

- **2026-08-02** — D1 allocation-fencing staging smoke passed on API
  `0c50c6dd7`. Real community provisioning reached `active`, its job succeeded,
  and the community was archived. An authenticated read serialized `created` as
  finite Unix seconds (`2026-08-02T16:13:30.000Z`), with no timestamp-decoder
  error. Staging was left on `0c50c6dd7` (Worker `fb01442d`).

- **2026-08-02** — The unreleased 2026-07-27 Lit rewards E2E rehearsal hold on
  API `ef87f6069` was invalidated by later shared-staging deploys; the Worker was
  observed on pinned API `42ecbe977` (build `2026-08-02T15:43:19Z`) before the
  stale entry was retired.

- **2026-07-27** — Feed fanout benchmark completed on API `5d9f4f67` (Worker
  `b606e79f`). Five valid 25-item samples spanning nine communities and 15
  authors measured wall-time p50 16.626s and p95/max 21.043s. Server timing
  attributed 13.123–17.595s to `community-fanout`, ~1.9s to viewer resolution,
  and 426–474ms to projection/ranking. All 27 recorded posts were deleted and
  a scoped rescan found zero benchmark-titled posts. Twenty-seven ~2 KB upload
  artifacts remain because the upload API has no deletion route. Staging was
  left on `5d9f4f67`.
- **2026-07-24** — API #760 + #768 scheduler soak passed on isolated candidate
  `2cc78ef5`. Two acquiring batches completed `process_community_jobs` in
  93.234s/91.036s against its 90s start-work budget, with only in-flight scan
  overshoot and both runs below the 120s lease. Prelude/drain phases were
  locked-delivery 20.440s/20.197s, stale sweep 15.805s/14.753s, processing
  6.481s/4.039s, and ops alerts 48.396s/49.775s. Rotation advanced between
  ticks; no runnable community jobs existed. Both reward watchdogs executed in
  both batches and were absent from the five deferred lower-priority jobs.
  Existing RPC rate-limit and community-schema errors remained; no new
  D1/Postgres connection-pressure regression was observed. Staging restored to
  authoritative Web pin `8461e236` (Worker version `cb047dba`).
- **2026-07-24** — API community-prelude bounding. `process_community_jobs`
  gained a 90s task deadline (`COMMUNITY_JOB_TASK_DEADLINE_MS`) and a 20s
  prelude sub-budget (`COMMUNITY_JOB_PRELUDE_DEADLINE_MS`) shared by the three
  per-community reconciles (locked delivery, song artifact session reaper, post
  publish finalize). Each prelude loop now rotates its community order per tick,
  gates new community starts on the deadline (never cancels in-flight work),
  and reports `reconcile_ms` plus checked/deferred counts; the drain keeps its
  45s tick deadline clamped to the task deadline, and `runOpsAlerts` scans with
  the remaining task time. The next staging soak should record the per-phase
  timings from the new `[community-jobs] scheduled task timing` log line
  instead of inferring the prelude from the task total.
- **2026-07-24** — API #760 scheduler-budget soak. Final candidate
  `8df4904e` bounded two stale sweeps to 15.420s/14.903s, then started processing
  46/43 rotated communities in 3.221s/3.022s; no runnable jobs were present.
  Both reward watchdogs started before the drain and were not deferred. The
  enclosing `process_community_jobs` task still took 223.227s/212.839s in other
  prelude/ops-alert work, with existing staging connection errors observed.
  Staging restored to authoritative Web pin `344ea443` (version `dec8f018`).
- **2026-07-23** — API #756 scheduler-bounding soak failed. Deployed squash
  `69a6c3e6` as Worker version `b843dfea`; the cutoff reported
  `started_communities=1` and `deferred_communities=99`, but that one community
  ran for 516.2s with zero jobs processed. Both reward monitors and five other
  jobs were still deferred. Rolled staging back to version `4b613d6d`, pinned
  API `f8636836`.
- **2026-07-23** — rewards qualification-projection gate. Deployed api main
  `4af45dbb`, measured reconciler durations and `reward_pending_qualifications`
  transitions, then released. Staging left on `4af45dbb`, later replaced by a
  web release deploying the pinned SHA. During this window a second session
  deployed the same SHA 13 seconds apart because the hold was recorded somewhere
  the other session could not read — the reason this file exists.
