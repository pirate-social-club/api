# Async Locked Delivery Runbook

Async locked delivery keeps Story CDR encryption, CDR writes, Story publish, and
royalty registration out of the user-visible post-create request. Locked assets
are created with `locked_delivery_status = "requested"` and a
`locked_asset_delivery_prepare` community job. Access, quotes, and settlement
stay blocked until the asset reaches `locked_delivery_status = "ready"`.

## Health Signals

- Locked video `post_create` p95 should stay under 10 seconds in staging and
  under 5 seconds in production once the edge path is warm. Isolated staging
  real-file runs on 4 MB videos have shown `post_create` around 5-6 seconds
  while Story/CDR readiness completes in the background.
- `locked_asset_delivery_prepare` jobs should normally start from the immediate
  `waitUntil` kick after post creation. `job_run_to_ready` may still take tens of
  seconds to a few minutes because it performs CDR, Story publish, and royalty
  registration in the background. Staging Story testnet runs have observed about
  90-150 seconds.
- The scheduled log line
  `[community-jobs] reconciled locked delivery jobs` should be rare. A single
  tick with `enqueued_jobs > 0` means a safety net repaired an orphan. Repeated
  ticks with any enqueues mean the immediate enqueue/kick path is unhealthy.
- `locked_delivery_status = "failed"` should be rare and should include a useful
  `locked_delivery_error`.

## Alerts

The scheduled reconciliation path sends a Sentry warning when it enqueues any
orphaned locked-delivery jobs.

- `urgency=low`: `enqueued_jobs` is 1-5. Triage during working hours unless it
  repeats.
- `urgency=high`: `enqueued_jobs > 5` in one tick. Treat as a broken enqueue or
  job-runner path.

Recommended Sentry alert rules:

- Notify on any
  `scheduled_task=community_jobs_locked_delivery_reconciliation` event where
  `urgency=high`.
- Notify if more than three low-urgency reconciliation events occur in 30
  minutes.
- Track failed `locked_asset_delivery_prepare` community jobs separately from
  reconciliation. Reconciliation fixes missing jobs, not failing Story/CDR work.

## Kill Switch

`STORY_LOCKED_DELIVERY_ASYNC=false` disables async delivery for new post
creation. Outside local/test environments, the default is async when the flag is
unset. Local/test default to sync unless the flag is set to `true`.

To disable async delivery:

1. Set `STORY_LOCKED_DELIVERY_ASYNC=false` for the API Worker environment.
2. Redeploy or restart the API Worker so new requests read the flag.
3. Leave the community job runner enabled. Existing queued/running
   `locked_asset_delivery_prepare` jobs should complete normally; the flag is
   read when new assets are created, not when jobs run.
4. Watch locked post-create latency. It will rise because Story/CDR work returns
   to the request path.

## Staging Validation

Before production, run the real-file timing harness against staging with real
Filebase and Story testnet configuration:

```bash
PIRATE_TIMING_API_BASE_URL=https://pirate-api-submission-speed-staging.hippiehecton.workers.dev \
PIRATE_TIMING_KIND=video-locked \
PIRATE_TIMING_RUNS=20 \
PIRATE_TIMING_REUSE_CREATED_COMMUNITY=true \
PIRATE_TIMING_READY_TIMEOUT_MS=1800000 \
PIRATE_TIMING_REQUEST_TIMEOUT_MS=60000 \
PIRATE_TIMING_EXPECT_GIT_SHA=<deployed-api-sha> \
PIRATE_TIMING_OUTPUT=scripts/generated-timing-runs/staging-20/video-locked-isolated-<sha>-20run-final.jsonl \
rtk env infisical run --project-config-dir ../../../core --env=staging --path=/services/api -- \
  rtk bun run timing:submission-e2e \
    --file ./scripts/generated-fixtures/4mb.mp4 \
    --poster-file ./scripts/generated-fixtures/poster.jpg
```

The harness preflights Story testnet funding and Turso capacity before it
creates communities or spends gas. For remote locked 20-runs, the default Story
funding preflight requires:

- `STORY_OPERATOR_PRIVATE_KEY` / CDR signer balance >= 3 IP for 20 locked runs
- `STORY_RUNTIME_FUNDER_PRIVATE_KEY + STORY_OPERATOR_PRIVATE_KEY` balance >= 5 IP
- `MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY` balance > 0

Royalty registration must use the Story direct transaction fee caps. The
uncapped Story SDK path previously accepted Aeneid RPC fee suggestions around
500 gwei, making `mintAndRegisterIpAndAttachPILTerms` cost roughly 0.575 IP per
run. The capped path uses `STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI` and
`STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI` like CDR/publish transactions.

Fund the staging Story runtime funder before long runs:

```text
0x3d02720a1C05129eE233796124494e0765B9A61A
```

After funding, top up runtime signers:

```bash
rtk env infisical run --project-config-dir ../../../core --env=staging --path=/services/api -- \
  rtk bun run scripts/fund-story-runtime-signers.ts --target-balance-wei=3000000000000000000
```

Do not use production timing runs for development iteration.

### Current Staging Evidence

Latest isolated staging deployment for the API feature code:

- Worker: `pirate-api-submission-speed-staging`
- URL: `https://pirate-api-submission-speed-staging.hippiehecton.workers.dev`
- Verified API SHA: `0718d3d`

Real-file timing evidence gathered before the final 20-run funding gate:

- Locked song 20-run succeeded on SHA `bb62204`:
  - publish path p50: about 16.6 seconds
  - `post_create` p50: about 5.8 seconds
  - `job_run_to_ready` p50: about 92 seconds
- Locked video real-file staging runs on SHA `b9142f5`:
  - successful run 1: `post_create` 5.7 seconds, `job_run_to_ready` 151.7 seconds
  - successful run 2: `post_create` 5.5 seconds, `job_run_to_ready` 141.0 seconds

The full locked-video 20-run remains a production gate. It is blocked until the
Story testnet funder has enough IP for the harness preflight.

## Local A/B Timing

Use `scripts/timing-runs.sh` against an already-running local API. Run once with
the current server, restart the API with `STORY_LOCKED_DELIVERY_ASYNC=true`, then
run again with a different label.

```bash
PIRATE_TIMING_COMMUNITY_ID=cmt_... rtk bash scripts/timing-runs.sh sync
PIRATE_TIMING_COMMUNITY_ID=cmt_... rtk bash scripts/timing-runs.sh async
```

The async run should move the old locked delivery cost from `post_create` to
`job_run_to_ready`.
