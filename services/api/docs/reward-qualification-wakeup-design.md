# Reward qualification wake-up

Status: implementation design for API issue #1200. The transport and consumer
remain disabled by default. Staging canary activation is blocked until the
staging ownership ledger is consistent and staging includes API `d2c634668` or
a descendant.

## Objective

Reduce qualification-to-credit latency without changing the money authority.
The community reward qualification outbox remains the durable source of truth,
and the existing reward campaign reconciler remains the only path that may
create reservations or reward events. The every-minute cron remains the
correctness backstop.

## Selected transport

Use a Cloudflare Queue as an at-least-once wake-up hint.

- Queue producer acceptance is durable but is not part of the community D1
  transaction. A failed or lost send cannot roll back a committed qualification
  and is recovered by cron.
- Queue delivery may be duplicate, delayed, reordered, or concurrent with cron.
  The existing checkpoint, unique claim, reservation, and reward-event
  transactions remain authoritative under every delivery pattern.
- The consumer uses a bounded batch and platform `max_concurrency`. Failed
  processing is retried with delay and eventually reaches a dead-letter queue.
- A separately named instance of the existing `ScheduledCronLockDO` provides a
  renewable reward-reconciler load-coordination lease shared by cron and Queue
  consumption. Database row locks and uniqueness constraints, not the lease,
  remain the exactly-once money authority. The maintenance lane lease is not
  used as the reward coordination boundary.

A Durable Object alarm was rejected as the transport. It provides per-object
at-least-once alarms and serialization, but only one replaceable alarm per
object, a smaller fixed retry envelope, and no native dead-letter path. A Queue
matches the required retry, poison-message, and backpressure behavior directly.

## Message contract

Version 1 JSON messages contain only routing and correlation data:

```json
{
  "schema_version": 1,
  "community_id": "internal community id",
  "event_id": "reward qualification outbox event id",
  "activity": "study or karaoke",
  "qualified_at": "ISO-8601 timestamp",
  "enqueued_at": "ISO-8601 timestamp"
}
```

The consumer never trusts the message for user, campaign, amount, score,
identity, or funding data. It reads the community outbox from its persisted
checkpoint and then runs the existing control-plane reconciliation gates.

## Commit and response boundary

Study materialization prepares an outbox candidate inside the existing community
write transaction. Routed D1 transactions buffer statements and cannot report
whether the insert won its uniqueness race before commit. Only after the
transaction commits does the request register a background task with its
execution context. That task owns fresh control-plane and community-read clients,
loads the authoritative outbox row by its uniqueness key, and enqueues only when
the stored event ID matches the candidate. The learner response does not wait for
confirmation or Queue acceptance. Missing bindings, disabled flags, confirmation
or send failures, and request termination are fail-soft because cron reads the
committed outbox independently.

An idempotent replay prepares a different candidate event ID, but authoritative
confirmation sees the existing event ID and emits no second hint. A crash after
commit but before hint registration is the explicit cron-recovery case. Karaoke
keeps cron-only ingestion until its distinct gateway transaction has separate
evidence and buffered-D1 coverage.

## Targeted reconciliation

Triggered processing supplies a bounded set of community IDs to the same
reconciler used by cron. In targeted mode:

- only those communities may advance qualification checkpoints;
- only explicitly hinted event IDs may be scanned for credit;
- hint mode does not run global campaign lifecycle or pending-expiry sweeps;
- solvency, funding, identity, budget, per-campaign period cap, score,
  reservation, retirement, and nationality behavior is unchanged;
- community IDs that have no qualifying campaign window are safe no-ops;
- the consumer does not implement SQL that creates money records.

Cron keeps its current rotation, 500-row community ingestion bound, and
500-credit invocation bound. The initial triggered path uses at most five
communities, 25 event IDs, 100 outbox rows per community, 25 attempted
qualifications, and 20 seconds of elapsed start-work time per batch. An event
deeper than the first outbox page remains unacknowledged; retries advance the
checkpoint in bounded pages until the event reaches the control plane. Queue
consumer concurrency starts at one. These are resource bounds, not policy or
money caps. Campaign rewards currently enforce their period cap per campaign;
there is no global cross-community user/day money cap in this reconciler.

## Coordination and recovery

Cron and the Queue consumer both acquire `reward-campaign-reconciliation`, a
distinct deterministic `ScheduledCronLockDO` instance. The owner renews before
one third of the lease elapses and stops acknowledging work if renewal fails.
Queue contention retries the affected messages; cron contention skips and the
next minute remains the backstop. Release is owner-checked, so an old invocation
cannot release a newer lease. This coordinates load; database constraints remain
authoritative if a lease is ever lost while in-flight work finishes.

Reprocessing is safe at each crash point:

1. Before checkpoint commit: the outbox row is read again.
2. After checkpoint commit and before credit: the control-plane event remains
   eligible for the credit scan.
3. After reservation or reward-event commit and before Queue acknowledgement:
   unique claims and reservation checks turn replay into a no-op.
4. After maximum Queue retries: the message enters the DLQ, while cron still
   reads the source outbox.

## Rollout flags

- `REWARD_QUALIFICATION_WAKEUP_ENQUEUE_ENABLED`: permits producer sends.
- `REWARD_QUALIFICATION_WAKEUP_CONSUMER_ENABLED`: permits triggered
  reconciliation. When false, delivered telemetry-only hints are acknowledged.
- `REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS`: comma-separated canary allowlist.
  Empty or absent admits no community.

Rollout order is telemetry-only enqueue, staging canary, bounded production
canary, then expansion. The staging canary must not begin while the shared
staging ownership hold is unresolved or before the negative-cache protection in
`d2c634668` is deployed there. Rollback disables enqueue and consumption; cron
requires no change.

Queue and DLQ creation plus environment-specific producer/consumer bindings are
a separate authorized rollout step. Runtime code may land with optional bindings
and absent flags, but no Queue consumer is attached merely by merging this
implementation.

## Observability

Structured logs correlate `event_id` and `community_id` across:

- qualification commit and hint registration;
- Queue acceptance or send failure;
- consumer receipt, attempt count, and queue age;
- lease acquisition or contention;
- ingestion and reconciliation summary;
- qualified-to-consumer and qualified-to-credit latency when a credit is
  created.

Database `qualified_at`, outbox `created_at`, control-plane `ingested_at`, and
reward-event `created_at` timestamps remain the durable latency authorities.
Queue backlog metadata, retry attempts, DLQ depth, cron recovery, gate outcomes,
and settlement-lane latency must be dashboarded before production expansion.

## Required verification

- committed outbox plus failed enqueue is later credited exactly once by cron;
- duplicate messages and a Queue/cron race credit exactly once;
- crashes before and after checkpoint advancement recover without loss;
- two target communities cannot advance one another's checkpoints;
- identity, funding, budget, cap, score, reservation, and retirement outcomes
  match cron;
- backlog above message, ingestion, and credit bounds drains incrementally;
- an account merge during delayed processing neither orphans nor duplicates the
  qualification;
- invalid messages retry into the DLQ without executing reconciliation.
