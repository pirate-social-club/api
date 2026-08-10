# Reward qualification cron-only baseline — 2026-08-11

## Purpose

Freeze the pre-Queue behavior used to judge the reward wake-up canary. This
record is observational only: it does not enable the producer or consumer,
provision a Queue, trigger a qualification, or change scheduler behavior.

## Version and window

- Environment: production (`api-core`)
- API SHA: `14b11392b34c3e999421645854efc13de2711525`
- Production deployments of this SHA completed at `2026-08-10T21:30:05Z`
  and `2026-08-10T22:00:06Z`; the natural release train redeployed the same
  API pin without changing the code under measurement.
- Cron: `*/1 * * * *`
- Wake-up state at this SHA: runtime code present but dormant; the Queue binding,
  Queue/DLQ configuration, producer flag, consumer flag, and community allowlist
  are absent.

The live window must end if `https://api.pirate.sc/__version` changes to another
SHA. A same-SHA redeploy is recorded above but does not split the code-level
baseline. Do not pool observations from another SHA into the current-SHA
distribution.

## Sources and definitions

Live scheduler evidence comes from Workers Logs for `api-core`:

- `[scheduled:maintenance] lane finished` supplies `lane_ms`;
- `lease held by another invocation` means the tick started zero maintenance
  jobs, including reward reconciliation;
- `[scheduled] slow job: reconcile_reward_campaigns` supplies reconciler runtime
  only when it is at least the five-second slow-job threshold;
- `[reward-campaigns] reconciled` supplies ingestion, duplicate, scan, credit,
  pending, deferral, and error counts.

End-to-end latency is defined from durable control-plane timestamps:

- qualification to ingestion: `reward_qualification_events.ingested_at - qualified_at`;
- ingestion to credit: `reward_events.created_at - reward_qualification_events.ingested_at`;
- qualification to credit: `reward_events.created_at - reward_qualification_events.qualified_at`.

The reward event identifies its qualification through
`campaign_rate_snapshot_json.qualification_event_id`.

## Live cron sample

The completed current-SHA invocations observed during this work are recorded
below.

| Scheduled at (UTC) | Maintenance outcome | `lane_ms` | Reward result |
| --- | --- | ---: | --- |
| `2026-08-10T21:38:12Z` | lane lease held; zero jobs started | 168 | did not run |
| `2026-08-10T22:01:12Z` | lane ran | 107,896 | 5,271 ms; 0 credits |
| `2026-08-10T22:02:12Z` | lane lease held; zero jobs started | 117 | did not run |
| `2026-08-10T22:03:12Z` | lane ran | 115,555 | 5,445 ms; 0 credits |
| `2026-08-10T22:04:12Z` | lane lease held; zero jobs started | 117 | did not run |
| `2026-08-10T22:05:12Z` | lane ran | 103,422 | 5,415 ms; 0 credits |
| `2026-08-10T22:06:12Z` | lane lease held; zero jobs started | 172 | did not run |
| `2026-08-10T22:07:12Z` | lane ran | 102,164 | 5,418 ms; 0 credits |
| `2026-08-10T22:08:12Z` | lane lease held; zero jobs started | 111 | did not run |
| `2026-08-10T22:09:12Z` | lane ran | 112,808 | 5,107 ms; 0 credits |
| `2026-08-10T22:10:12Z` | lane lease held; zero jobs started | 123 | did not run |
| `2026-08-10T22:11:12Z` | lane ran | 100,533 | 5,373 ms; 0 credits |
| `2026-08-10T22:12:12Z` | lane lease held; zero jobs started | 135 | did not run |
| `2026-08-10T22:14:12Z` | lane lease held; zero jobs started | 126 | did not run |

The `22:13:12Z` invocation was still running when capture stopped and is excluded
from duration statistics; the `22:14:12Z` lease-held result proves it had not
released the lane before the following tick.

The observed maintenance-lane sample is deliberately small (`n = 14`): median
170 ms, maximum 115,555 ms, and eight lease-held ticks that started zero jobs
(57.1%).
The low median is not healthy latency; it is the fast return of skipped work.
Among lanes that actually ran (`n = 6`), duration was 100,533–115,555 ms
(median 105,659 ms). Every captured running lane exceeded the 60-second cron
interval, and every one caused at least the following tick to skip maintenance.

For the six runs where the reward job started, preceding protected work delayed
its start by 14,575–20,384 ms (median 16,939.5 ms). The reward job took
5,107–5,445 ms (median 5,394 ms), putting reward completion 20,020–25,655 ms
after the scheduled timestamp (median 22,179.5 ms). All six runs scanned one
campaign community and the same three qualifications, ingested zero new rows,
credited zero events, and left all three pending on identity verification.
There were no duplicate, funding, budget, campaign, community, or reconciler
errors in any summary.

For a newly durable qualification, the cron-only path therefore contains:

1. zero to roughly 60 seconds of cron phase wait;
2. one or more whole-minute additions when the maintenance lane lease is held;
3. an observed 14.6–20.4 seconds behind preceding protected work on a tick that
   acquires the lane;
4. an observed 5.1–5.4 seconds in reward reconciliation.

This is a component model, not an end-to-end percentile. In this window there
was only one campaign community and every successful run scanned it, so the
50-community rotation did not add delay. Under the captured load, however, an
executing maintenance lane consistently occupied the lease across the next
minute and made reward-start opportunities effectively arrive about every two
minutes.
The live sample therefore measures scheduler delay and reconciler runtime, but
contains no credited event from which to compute end-to-end latency.

This directly reproduces the whole-minute loss mechanism: a cron tick can fire
successfully while reward reconciliation does not start at all. The 21:38
invocation's separate community-job lane ran for 83,197 ms; current-deployment
samples were also routinely above 75 seconds. That lane has its own lease, so
its duration is context rather than the cause of the maintenance skips.

## What the emitted logs cannot measure

The current reconciler summary has counts but no event timestamps or latency
fields. Lane logs therefore cannot reconstruct a qualified-to-credit
distribution. They can measure scheduling availability and long reconciler
runs, but joining a credit to its durable qualification requires the
control-plane rows.

Consequently, the scheduler sample above is a valid current-SHA cron baseline,
but an end-to-end percentile must not be invented from it. Run the following
read-only query through the approved control-plane read path before enabling
the staging producer. Use the deployment completion above as the lower bound
and the captured version-change time (or query time) as the upper bound.

```sql
WITH credited AS (
  SELECT
    q.reward_qualification_event_id,
    EXTRACT(EPOCH FROM (q.ingested_at - q.qualified_at)) * 1000
      AS qualification_to_ingestion_ms,
    EXTRACT(EPOCH FROM (r.created_at - q.ingested_at)) * 1000
      AS ingestion_to_credit_ms,
    EXTRACT(EPOCH FROM (r.created_at - q.qualified_at)) * 1000
      AS qualification_to_credit_ms
  FROM reward_events r
  JOIN reward_qualification_events q
    ON q.reward_qualification_event_id =
      r.campaign_rate_snapshot_json ->> 'qualification_event_id'
  WHERE r.source = 'reward_campaign_reconciler'
    AND r.reward_kind = 'campaign_practice_day'
    AND r.created_at >= TIMESTAMPTZ '2026-08-10T21:30:05Z'
    AND r.created_at < TIMESTAMPTZ '<window-end-utc>'
), distribution AS (
  SELECT
    COUNT(*) AS credited_events,
    PERCENTILE_CONT(0.50) WITHIN GROUP (
      ORDER BY qualification_to_credit_ms
    ) AS p50_ms,
    PERCENTILE_CONT(0.90) WITHIN GROUP (
      ORDER BY qualification_to_credit_ms
    ) AS p90_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (
      ORDER BY qualification_to_credit_ms
    ) AS p95_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (
      ORDER BY qualification_to_credit_ms
    ) AS p99_ms,
    MAX(qualification_to_credit_ms) AS max_ms,
    PERCENTILE_CONT(0.50) WITHIN GROUP (
      ORDER BY qualification_to_ingestion_ms
    ) AS ingestion_p50_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (
      ORDER BY qualification_to_ingestion_ms
    ) AS ingestion_p95_ms,
    PERCENTILE_CONT(0.50) WITHIN GROUP (
      ORDER BY ingestion_to_credit_ms
    ) AS credit_after_ingestion_p50_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (
      ORDER BY ingestion_to_credit_ms
    ) AS credit_after_ingestion_p95_ms
  FROM credited
)
SELECT * FROM distribution;
```

If the result has fewer than 20 credits, retain the raw count, median, and
maximum but mark tail percentiles provisional. Do not combine staging fixture
traffic or evidence from older SHAs merely to increase the sample.

## Canary comparison contract

Compare the canary with this baseline using the same timestamp definitions and
report:

1. qualification-to-ingestion and qualification-to-credit `p50`, `p95`, and
   maximum;
2. successful credits and gate outcomes;
3. duplicate/no-op outcomes divided by processed hints;
4. hints recovered by cron after enqueue or consumer failure;
5. maintenance-lane lease-held ticks and reward reconciler lock contention;
6. control-plane/D1 pressure and settlement-lane latency;
7. Queue and DLQ depth, with an explicit alert owner before any consumer is
   enabled.

Historical timings cited in API issue #1200 are diagnostic context only. They
were observed on a different SHA and remain provisional until reproduced by
durable metrics, so they are intentionally excluded from this baseline.
