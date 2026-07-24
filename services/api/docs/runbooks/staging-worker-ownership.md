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

RTK's hook drops `--define` arguments, which is why some deploys show
`git_sha: null`. Deploy through `rtk proxy` from `services/api`:

```
rtk proxy bunx wrangler@4.100.0 deploy --env staging \
  --define "__PIRATE_BUILD_GIT_SHA__:\"<sha>\"" \
  --define "__PIRATE_BUILD_GIT_REF__:\"<ref>\"" \
  --define "__PIRATE_BUILD_TIMESTAMP__:\"<iso>\""
```

Then confirm with `curl -s https://api-staging.pirate.sc/__version`.

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

_None._

## Hold history

Keep entries short. Delete them once they are no longer useful context.

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
