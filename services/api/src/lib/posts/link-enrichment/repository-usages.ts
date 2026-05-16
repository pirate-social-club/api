import type { Client } from "../../sql-client"
import { toLinkEnrichmentUsageRecord } from "./repository-rows"
import type { LinkEnrichmentUsageRecord } from "./types"

export async function upsertLinkEnrichmentUsage(input: {
  client: Client
  normalizedUrl: string
  communityId: string
  postId: string
  linkEnrichmentId: string | null
  snapshotSyncedAt: string | null
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO link_enrichment_usages (
        normalized_url, community_id, post_id, link_enrichment_id,
        snapshot_synced_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?6
      )
      ON CONFLICT(normalized_url, community_id, post_id) DO UPDATE SET
        link_enrichment_id = excluded.link_enrichment_id,
        snapshot_synced_at = excluded.snapshot_synced_at,
        updated_at = excluded.updated_at
    `,
    args: [
      input.normalizedUrl,
      input.communityId,
      input.postId,
      input.linkEnrichmentId,
      input.snapshotSyncedAt,
      input.now,
    ],
  })
}

export async function listLinkEnrichmentUsages(input: {
  client: Client
  normalizedUrl: string
}): Promise<LinkEnrichmentUsageRecord[]> {
  const result = await input.client.execute({
    sql: `
      SELECT normalized_url, community_id, post_id, link_enrichment_id,
             snapshot_synced_at, created_at, updated_at
      FROM link_enrichment_usages
      WHERE normalized_url = ?1
      ORDER BY updated_at ASC, community_id ASC, post_id ASC
    `,
    args: [input.normalizedUrl],
  })
  return result.rows.map(toLinkEnrichmentUsageRecord)
}

export async function updateLinkEnrichmentUsageSnapshotSyncedAt(input: {
  client: Client
  normalizedUrl: string
  communityId: string
  postId: string
  snapshotSyncedAt: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE link_enrichment_usages
      SET snapshot_synced_at = ?4,
          updated_at = ?5
      WHERE normalized_url = ?1
        AND community_id = ?2
        AND post_id = ?3
    `,
    args: [
      input.normalizedUrl,
      input.communityId,
      input.postId,
      input.snapshotSyncedAt,
      input.updatedAt,
    ],
  })
}
