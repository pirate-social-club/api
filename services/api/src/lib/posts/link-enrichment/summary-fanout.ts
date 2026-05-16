import type { DbExecutor } from "../../db-helpers"
import type { Client } from "../../sql-client"
import { updatePostLinkPreviewMetadata } from "../community-post-link-preview-store"
import {
  listLinkEnrichmentUsages,
  updateLinkEnrichmentUsageSnapshotSyncedAt,
} from "./repository-usages"

export async function writeLinkEnrichmentSnapshotToPost(input: {
  client: DbExecutor
  postId: string
  snapshotJson: string
  syncedAt: string
}): Promise<void> {
  const snapshot = JSON.parse(input.snapshotJson) as {
    title?: unknown
    image_url?: unknown
  }
  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.postId,
    linkOgImageUrl: typeof snapshot.image_url === "string" ? snapshot.image_url : null,
    linkOgTitle: typeof snapshot.title === "string" ? snapshot.title : null,
    linkEnrichmentSnapshotJson: input.snapshotJson,
    linkEnrichmentSyncedAt: input.syncedAt,
    updatedAt: input.syncedAt,
  })
}

export async function listLinkSummaryFanoutUsages(input: {
  controlPlaneClient: Client
  normalizedUrl: string
}) {
  return listLinkEnrichmentUsages({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
  })
}

export async function markLinkSummaryFanoutSynced(input: {
  controlPlaneClient: Client
  normalizedUrl: string
  communityId: string
  postId: string
  syncedAt: string
}) {
  await updateLinkEnrichmentUsageSnapshotSyncedAt({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
    communityId: input.communityId,
    postId: input.postId,
    snapshotSyncedAt: input.syncedAt,
    updatedAt: input.syncedAt,
  })
}
