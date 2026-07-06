# Async Song Publish Alerts

Async song publish intentionally moves analysis, Story registration, listing
creation, and catalog sync into `post_publish_finalize` community jobs. User
experience is now better when a dependency fails, but the system only works
operationally if failures page the team before users report stuck or failed
processing cards.

## Required Sentry Rules

Create these rules in the API Sentry project:

1. **Story runtime signer low balance**
   - Filter: `scheduled_task:story_runtime_funding_watchdog`
   - Page immediately when `urgency:high`.
   - Notify during working hours for any event with `urgency:low`.
   - Response: follow `story-signer-funding.md`.

2. **Post publish finalize job failure**
   - Filter: `pipeline:community_jobs job_type:post_publish_finalize`
   - Page if the event count is greater than 0 in 10 minutes.
   - Response: inspect the event `extra.subject_id`, `extra.attempt_count`, and
     the post's `publish_failure_code`. Retryable product failures should have
     moved the post to a failed/retryable author-visible card; unhandled job
     failures mean the dependency or state machine needs triage.

3. **Stuck publish reconciler sweep**
   - Filter: `scheduled_task:community_jobs_post_publish_finalize_reconciliation`
   - Page immediately when `urgency:high`.
   - Notify during working hours for any event with `urgency:low`.
   - Response: check whether `extra.failed_posts` is isolated or recurring. A
     recurring sweep means jobs are dying before the finalize handler can mark
     posts failed itself.

4. **Scheduled community-jobs runner failure**
   - Filter: `scheduled_task:community_jobs`
   - Page if the event count is greater than 0 in 10 minutes.
   - Response: this is broader than song publish. It means the scheduled runner
     failed outside an individual job's captured failure path.

Create this rule in the web Sentry project:

5. **Song submit client failure**
   - Filter: message or breadcrumb contains `[song-submit]`, or event source
     identifies the song submit flow.
   - Notify during working hours for any event. Page only if several users are
     affected in a short window.
   - Response: inspect the submit step breadcrumbs. Client-side failures before
     `create_post` usually mean upload/session problems; failures after
     `create_post` should be rare because async publish continues server-side.

## Healthy Signals

- `post_publish_finalize` jobs usually leave `processing` within one cron/job
  drain window after upload completes.
- A failed author-visible card is expected for rejected or temporarily failed
  publishes; a forever-processing card is not expected.
- The reconciler may emit a low-urgency event after a Worker crash or retry
  exhaustion. Repeated events are not healthy.
- The Story signer watchdog should be quiet in normal operation.

## Manual Spot Checks

Use these after the first organic publishes in a new rollout:

1. Confirm new song posts move from `processing` to `published` or `failed`.
2. Confirm paid-song posts have a listing created server-side.
3. Confirm `post_publish_finalize` jobs are not accumulating failed attempts.
4. Confirm Sentry has no matching events for the required rules above.

