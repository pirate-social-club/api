import type { DbExecutor } from "../db-helpers"
import {
  boundedPostJsonProjection,
  OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON,
} from "./community-post-projection"

export async function updatePostLinkPreviewMetadata(input: {
  client: DbExecutor
  postId: string
  linkOgImageUrl: string | null
  linkOgTitle: string | null
  linkEnrichmentSnapshotJson?: string | null
  linkEnrichmentSyncedAt?: string | null
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET link_og_image_url = ?2,
          link_og_title = ?3,
          link_enrichment_snapshot_json = COALESCE(?4, link_enrichment_snapshot_json),
          link_enrichment_synced_at = COALESCE(?5, link_enrichment_synced_at),
          updated_at = ?6
      WHERE post_id = ?1
        AND post_type = 'link'
    `,
    args: [
      input.postId,
      input.linkOgImageUrl,
      input.linkOgTitle,
      boundedPostJsonProjection(
        input.linkEnrichmentSnapshotJson,
        OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON,
      ),
      input.linkEnrichmentSyncedAt ?? null,
      input.updatedAt,
    ],
  })
}
