# Database Migrations

This tree is a worker-local fixture copy, not the canonical migration source.

- `/home/t42/Documents/pirate-v2/db/` is canonical for operational docs and bootstrap commands.
- Keep the community-template tree here aligned with the canonical community-template migrations.
- Control-plane files here may intentionally diverge from canonical `db/control-plane/migrations/` when the local worker fixture target is SQLite/libSQL instead of PostgreSQL/Neon.

Pirate v2 now has two relational migration roots:

- `db/control-plane/migrations/`
  Central Pirate-owned Turso database for identity, auth links, verification, community routing, encrypted community credentials, global scrobble and track anchor state, projections, jobs, and audit.
- `db/community-template/migrations/`
  Baseline per-community schema applied to each new community `main` database at provisioning time.

Related docs:

- [turso-control-plane-schema.md](/home/t42/Documents/pirate-v2/docs/turso-control-plane-schema.md)
- [turso-provisioning-contract.md](/home/t42/Documents/pirate-v2/docs/turso-provisioning-contract.md)
- [turso-data-boundaries.md](/home/t42/Documents/pirate-v2/docs/turso-data-boundaries.md)

## Current Scope

These migrations are the first executable baseline, not the final full product schema.

Current posture:

- control-plane migrations are intended to be real and durable
- community-template migrations intentionally cover only the stable v0 sovereignty core
- richer commerce, analytics, and read-model denormalizations can be added later in new migrations

## Ordering

Control-plane migrations:

- `0001_control_plane_identity.sql`
- `0002_control_plane_communities.sql`
- `0003_control_plane_scrobbles.sql`
- `0004_control_plane_jobs_and_audit.sql`
- `0005_control_plane_namespace_verification.sql`
- `0006_control_plane_community_create_idempotency.sql`
- `0007_control_plane_registry_publication.sql`
- `0008_control_plane_reddit_onboarding_and_profiles.sql`
- `0009_control_plane_market_context_bindings.sql`
- `0010_control_plane_community_money_policies.sql`
- `0011_control_plane_song_artifact_bundles.sql`
- `0012_control_plane_song_artifact_uploads.sql`
- `0013_control_plane_song_artifact_upload_storage_metadata.sql`
- `0014_control_plane_community_discovery_projection.sql`
- `0015_control_plane_song_artifact_bundle_enrichment.sql`
- `0016_control_plane_community_pricing_policies.sql`
- `0017_control_plane_song_artifact_bundle_preview_window.sql`
- `0018_control_plane_song_artifact_bundle_preview_status.sql`

Community-template migrations:

- `1001_community_core.sql`
- `1002_community_listings.sql`
- `1003_community_post_idempotency.sql`
- `1004_community_market_context.sql`
- `1005_community_purchase_quotes.sql`
- `1006_community_assets.sql`
- `1007_community_cached_counts.sql`
- `1008_community_gate_rules.sql`
- `1009_community_purchase_quote_verification_snapshots.sql`
- `1010_community_post_flair.sql`
- `1011_community_asset_story_publish_inputs.sql`
- `1012_community_asset_media_descriptors.sql`
- `1013_community_asset_locked_delivery_payload.sql`
- `1014_community_purchase_quote_settlement_amount.sql`

## Local Apply

Until a runtime repo grows its own migration command, this repo provides a local
SQLite/libSQL migration runner:

```bash
rtk bash scripts/apply-sqlite-migrations.sh \
  --db /tmp/pirate-control-plane.db \
  --migrations db/control-plane/migrations \
  --label control-plane

rtk bash scripts/apply-sqlite-migrations.sh \
  --db /tmp/pirate-community-template.db \
  --migrations db/community-template/migrations \
  --label community-template
```

The runner:

- applies `.sql` files in lexicographic order
- records successful applications in `schema_migrations`
- skips already-applied migrations when the checksum matches
- fails if a previously applied migration file has changed

## Local Fixtures

Control-plane fixture seed for the JWT-first, no-browser path:

```bash
rtk bash scripts/seed-control-plane-fixtures.sh \
  --db /tmp/pirate-control-plane.db \
  --user-id usr_demo_01 \
  --subject demo-subject-01 \
  --handle demo \
  --namespace-label demo
```

Local community bootstrap using the seeded namespace verification:

```bash
rtk bash scripts/bootstrap-community-db.sh \
  --db /tmp/pirate-community-demo.db \
  --community-id cmt_demo_01 \
  --user-id usr_demo_01 \
  --display-name "Demo Community" \
  --namespace-verification-id nv_demo_usr_demo_01 \
  --namespace-label demo
```

## Notes

- These files target SQLite-compatible Turso/libSQL DDL.
- Community databases intentionally do not define a `users` table. They reference central Pirate `user_id` values as foreign identifiers, not local user rows.
- This repo now includes a local SQLite/libSQL migration runner in `scripts/apply-sqlite-migrations.sh`.
