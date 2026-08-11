# Schema-mainline deploy order

Use this order whenever an API release removes request-time schema creation,
repair, or missing-column fallbacks. A migrated schema is a hard dependency of
the Worker after such a release.

## Required order

1. Inspect the staging and production control-plane migration ledgers from the
   Core checkout. The inspection is read-only:

   ```bash
   rtk infisical run --env staging --path /services/control-plane -- \
     rtk bun scripts/control-plane/inspect-control-plane-migration-ledger.ts \
       --database-url-env CONTROL_PLANE_MIGRATOR_DATABASE_URL --limit 4

   rtk infisical run --env prod --path /services/control-plane -- \
     rtk bun scripts/control-plane/inspect-control-plane-migration-ledger.ts \
       --database-url-env CONTROL_PLANE_MIGRATOR_DATABASE_URL --limit 4
   ```

2. Apply the reviewed Core control-plane migrations through the API release
   pin. For the audit mainlining release, this includes
   `0079_control_plane_community_health_counts.sql`,
   `0213_control_plane_global_handle_integer_money.sql`, and
   `0214_control_plane_community_health_sync_watermark.sql`. The
   `community_health_counts` migration must precede every `/home` and
   `/home/videos` Worker deployment because those reads now fail visibly when
   the table is absent.
3. Converge the community fleet through the schema floor declared in
   `community-schema-requirements.json`. This release depends on the karaoke
   policy columns from migrations 1096/1098, the study flag from migration
   1115, and integer commerce storage from migration 1154.
4. Deploy the API Worker only after both schema lanes succeed. Rolling the
   Worker back does not roll either schema lane back.

After this cutover, schema drift and transient shard-read failure are both
fail-visible on affected reads. This is an intentional correctness-first
availability trade: route handlers must not restore catch-all defaults for
migration-owned fields.

## Community-health projection cutover

Migration 0214 transfers ownership from the old absolute full-history
projection to the daily additive projection. On the first sync after cutover,
the worker atomically claims the reset state and deletes all existing
`community_health_counts` rows. It starts ingesting complete UTC days on the
next run. Community view totals and rankings will therefore be near zero until
new daily counts accumulate.

This reset is an intentional product-visible change and requires explicit
release sign-off. Record the cutover timestamp and notify operators who use
community-health rankings before enabling the new runtime.

The daily Tinybird query fails closed at 100,000 rows and does not advance its
watermark. The scheduled runner emits the dedicated high-urgency
`community_health_sync_saturated` alert with the blocked date and row limit.
Repeated runs remain blocked on that date until an operator changes the
Tinybird aggregation/pagination so the complete day can be fetched; do not
manually advance the watermark or accept a truncated day.

## Retired song-artifact healer check

Before deploying the release that deletes the four song-artifact healers,
confirm these exact ledger rows in both environments:

```sql
SELECT migration_name, checksum
FROM schema_migrations
WHERE migration_name IN (
  '0080_control_plane_song_artifact_bundle_title.sql',
  '0096_control_plane_song_artifact_bundle_genius_annotations_url.sql',
  '0128_control_plane_song_artifact_alignment_reason.sql',
  '0129_control_plane_song_artifact_karaoke_revision.sql'
)
ORDER BY migration_name;
```

The canonical checksums are:

| Migration | Canonical checksum | Retired healer checksum |
| --- | --- | --- |
| 0080 title | `7f09e6466cce0964cde1fec55fba297a6c308c008b92574ab331eeb782ce2f01` | `5051c88bdbf9d3278d5e23c049f88a5594b101d9de1e976744a76dcc51c6797e` |
| 0096 annotations URL | `0196a24f1d5b09c216d42caa3d17260e6987d8ab618d809dcd72f1626fb64e8b` | `a2630c67b0c7dd722e925bd7162659feeb4d4c611521f46ade94e177eb5b5a6f` |
| 0128 alignment reason | `4a4d027f1a60342855fff6e20df2da0d299cd42393dc1d46f2d0123c043a48c3` | same |
| 0129 karaoke revision | `81ea2a26d5316225e20478fe4d23cfd684483448713ade0a5bada90eef593728` | same |

If either retired 0080/0096 checksum is present, stop the deployment. Register
the exact old-to-current checksum in Core's reviewed
`db/local-control-plane-migration-drifts.json`, or use the approved break-glass
repair path. Do not update the ledger with an ad hoc SQL write.

## 2026-08-11 preflight evidence

The read-only inspector completed against staging and production. Both reported
zero checksum mismatches. The only expected migrations missing from each were
the new, not-yet-applied 0213 and 0214 drafts. No compatibility drift entry is
needed for the retired healers in either long-lived environment.
