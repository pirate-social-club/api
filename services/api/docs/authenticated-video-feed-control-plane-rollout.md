# Authenticated video feed: control-plane serving rollout

## Goal

Remove per-community shard fanout from authenticated video-feed reads without
changing feed output, visibility, or viewer-specific state. The target serving
shape is one indexed control-plane candidate read followed by bounded,
request-time enrichment and policy reranking.

## Existing source of truth

`community_post_projections` is a control-plane table. Its
`projected_payload_json` column already receives the complete `Post` payload on
post creation and is updated by the existing projection write paths. This is
the base renderable projection.

The older `feed_post_projections` table is not part of this plan: production
code neither writes nor reads it.

No community-shard schema migration is required for the base projection.

## Data still missing from the control plane

The projected post is not yet a complete `HomeFeedItem`. The current shard
reader also supplies:

- viewer vote and reaction state;
- membership gate state and policy;
- thread snapshots;
- localization and translation provenance;
- labels, karaoke/study capabilities, derivatives, and other enrichments;
- community identity; and
- public author handles.

Community identity already exists in the control-plane community row, and
author handles can be batch-read from the control-plane profile repository.
Viewer votes/reactions need an explicit projection and dual-write/backfill
before the projected path can preserve authenticated response parity.

## Rollout phases

1. **Shadow validation**
   - Select `projected_payload_json` with the ranked candidate rows.
   - Strictly validate row/payload identity, community, type, visibility,
     author, and media references.
   - Compare it with the existing shard-hydrated response.
   - Emit only aggregate reason codes and timings; never post content or user
     identifiers.
   - Enable explicitly with
     `AUTHENTICATED_VIDEO_FEED_CONTROL_PLANE_MODE=shadow`.

2. **Complete viewer projections**
   - Add control-plane viewer vote/reaction storage in a Core control-plane
     migration.
   - Dual-write vote/reaction set and clear operations.
   - Backfill idempotently, record coverage, and retain shard reads as the
     authority during verification.
   - Batch-resolve community identity and author handles.
   - Define parity-safe defaults or projections for every remaining
     enrichment; do not silently omit fields.

3. **Serve behind a kill switch**
   - Add a `serve` implementation only after shadow coverage and mismatch
     thresholds are accepted.
   - Require all rows in a page to be projection-complete. Fall back the whole
     page to the legacy reader when any required projection is missing or
     invalid, avoiding mixed response semantics.
   - Preserve the existing iterative, cursor-aware candidate backfill.
   - Compare sampled served responses against legacy hydration.

4. **Retire shard fanout**
   - Remove the fallback only after production coverage, latency, and parity
     objectives hold for the agreed observation window.
   - Keep the mode as an operational rollback until the new path has survived
     a full release cycle.

## Schema and deployment gates

Any new control-plane schema starts in the canonical Core migration directory,
then updates API test fixtures/generated schema through the repository’s
normal migration workflow. Deploy schema before dual-writes, dual-writes before
backfill, and backfill before `serve`. Every migration and backfill must be
idempotent.

Community-shard template migrations are explicitly out of scope unless later
work proves a required field cannot be projected from existing write events.

## Acceptance criteria

- Shadow mode never changes returned items, ordering, cursor, or status code.
- Logs contain counts and stable reason codes only.
- `serve` is not implemented or enabled while viewer vote/reaction parity is
  missing.
- A missing or corrupt projection causes whole-page legacy fallback.
- Authenticated p95 origin latency and shard read count are measured before and
  after rollout.
