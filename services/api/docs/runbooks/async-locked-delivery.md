# Async Locked Delivery Runbook

Async locked delivery keeps Story CDR encryption, CDR writes, Story publish, and
royalty registration out of the user-visible post-create request. Locked assets
are created with `locked_delivery_status = "requested"` and a
`locked_asset_delivery_prepare` community job. Access, quotes, and settlement
stay blocked until the asset reaches `locked_delivery_status = "ready"`.

## Health Signals

- Locked video `post_create` p95 should stay under 5 seconds in staging and
  production. Local real-file timing currently shows about 650ms for 4 MB locked
  video after warmup.
- `locked_asset_delivery_prepare` jobs should normally start from the immediate
  `waitUntil` kick after post creation. `job_run_to_ready` may still take tens of
  seconds because it performs the Story/CDR work in the background.
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
PIRATE_TIMING_API_BASE_URL=https://api-staging.pirate.sc \
PIRATE_TIMING_COMMUNITY_ID=<staging-community-id> \
PIRATE_TIMING_RUNS=20 \
PIRATE_TIMING_WARMUP_RUNS=1 \
rtk bun run timing:local-runs --label staging-async
```

Use a staging community and funded test wallet. Do not use production timing
runs for development iteration.

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

Story royalty registration uses the same direct transaction caps as the other
Story runtime writes:

```text
STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI=5000000000
STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI=2000000000
STORY_DIRECT_TX_GAS_LIMIT_MAX=1500000
STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS=12000
```

With those caps, one registration attempt is bounded at:

```text
1,500,000 gas * 5 gwei = 7,500,000,000,000,000 wei = 0.0075 IP
```

Using 2x retry headroom gives a required per-run signer balance floor of
0.015 IP. The configured `STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI` is 0.1 IP and
`STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI` is 0.25 IP, so the runtime funding
preflight stays above the bounded worst-case registration cost.
