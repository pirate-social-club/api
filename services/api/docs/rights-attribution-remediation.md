# Rights attribution remediation

## Safety invariant

Neither clear action may resolve a review after Story royalty registration has started. For `pending` or completely `registered` lineage, `clear` and `clear_with_upstream_refs` return `409` with the top-level code `story_lineage_correction_required` and perform no post, derivative-link, case, analysis, or hold mutation.

The action is intentionally not a correction operation: it unions references and inserts derivative links. It cannot remove a mistaken reference or reconcile Story state.

## Dedicated correction operation

Build a separate operator-only workflow with an immutable journal and these phases:

1. Capture the post, asset, declared references, derivative links, analysis, hold, Story parent IPs, royalty allocation fingerprint, and transaction references.
2. Resolve both old and replacement references through their owning community shards. Persist canonical references that retain the source community identity; a bare foreign `story:asset:<asset_id>` is not resolvable from the derivative's shard.
3. Determine whether Story supports correcting or superseding the registered lineage. If it does not, stop for manual reconciliation rather than rewriting D1 to disagree with the chain.
4. Apply the chain reconciliation and record its receipts.
5. In one target-shard transaction, replace the declared reference set, remove the stale derivative link, insert the replacement link, and enqueue rights re-analysis. Replacement must assert the captured pre-state so concurrent edits fail.
6. Re-analysis must resolve declarations cross-shard and compare the replacement set, not a union. Release the hold only after the expected detected bundle is verified and the Story reconciliation is confirmed.
7. Notify the author and moderators with the correction result and retained audit record.

The operation must be idempotent by correction ID and resume from its journal after partial external failure.

## Distribution policy follow-up

Read surfaces should consume one derived distribution state instead of querying `rights_holds` directly. The initial states are:

- `public`: visible normally.
- `author_mod_only`: hidden from third parties, visible to the author and moderators with a reason and remediation action.
- `suppressed`: unavailable except to authorized moderation tooling.

Map `declared_reference_mismatch` to `author_mod_only` plus a commerce hold. Apply the same state to community lists, home feeds, and permalinks. Creating a state transition must notify the author; deletion must close cases and release or archive associated holds.

## Composer follow-up

Run upload-time fingerprinting as a bounded best-effort preflight. When a custom-catalog match disagrees with the selected source, offer the detected source, keep-and-explain, or cancel. Provider failure must not become a global posting outage; unresolved cases fall back to the coherent post-publish state above.

## Cross-community repost measurement follow-up

Video-audio enrollment/unenrollment evidence currently lives only in each community shard's `media_analysis_results.authenticity_signals_json`. That is sufficient to validate the mechanics (enroll on analysis, unenroll on deletion, redacted tombstones), but not for operational cross-community repost measurement, which needs to query repost relationships across shards.

Migrate to a control-plane observation table in the `core` repo (PlanetScale), keyed by global post/community ids, and mirror enrollment and unenrollment outcomes there. Until that lands, cross-community repost metrics remain unavailable even though shard-local evidence is complete.
