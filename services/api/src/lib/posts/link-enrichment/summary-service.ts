import type { Env } from "../../../env"
import type { DbExecutor } from "../../db-helpers"
import type { Client } from "../../sql-client"
import { updatePostLinkPreviewMetadata } from "../community-post-store"
import {
  buildLinkEnrichmentSnapshot,
  getLinkEnrichmentByNormalizedUrl,
  listLinkEnrichmentUsages,
  updateLinkEnrichmentSummary,
  updateLinkEnrichmentUsageSnapshotSyncedAt,
} from "./repository"
import { requestLinkSummary } from "./summary-provider"

export async function generateAndStoreLinkSummary(input: {
  env: Env
  controlPlaneClient: Client
  normalizedUrl: string
  now: string
  fetcher?: typeof fetch
}): Promise<{
  resultRef: string
  snapshotJson: string | null
}> {
  const record = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
  if (!record) {
    return { resultRef: "skipped:missing_enrichment", snapshotJson: null }
  }
  if (record.status !== "ready") {
    return { resultRef: `skipped:${record.status}`, snapshotJson: null }
  }
  if (record.summary_status === "ready" && record.summary_json) {
    return {
      resultRef: "skipped:summary_ready",
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(record)),
    }
  }
  if (!record.markdown?.trim()) {
    const unavailable = await updateLinkEnrichmentSummary({
      client: input.controlPlaneClient,
      normalizedUrl: input.normalizedUrl,
      summaryJson: null,
      summaryStatus: "unavailable",
      summaryModel: null,
      summarizedAt: input.now,
      error: "no_markdown",
      updatedAt: input.now,
    })
    return {
      resultRef: "unavailable:no_markdown",
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(unavailable)),
    }
  }

  await updateLinkEnrichmentSummary({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
    summaryJson: null,
    summaryStatus: "pending",
    summaryModel: null,
    summarizedAt: input.now,
    error: null,
    updatedAt: input.now,
  })

  try {
    const summary = await requestLinkSummary({
      env: input.env,
      title: record.title,
      publisher: record.publisher,
      publishedAt: record.published_at,
      markdown: record.markdown,
      fetcher: input.fetcher,
    })
    const summaryJson = JSON.stringify({
      summary_paragraph: summary.summaryParagraph,
      short_summary: summary.shortSummary,
      key_points: summary.keyPoints,
      generated_at: input.now,
      model: summary.model,
    })
    const updated = await updateLinkEnrichmentSummary({
      client: input.controlPlaneClient,
      normalizedUrl: input.normalizedUrl,
      summaryJson,
      summaryStatus: "ready",
      summaryModel: summary.model,
      summarizedAt: input.now,
      error: null,
      updatedAt: input.now,
    })
    return {
      resultRef: `ready:${updated.normalized_url}`,
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(updated)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = await updateLinkEnrichmentSummary({
      client: input.controlPlaneClient,
      normalizedUrl: input.normalizedUrl,
      summaryJson: null,
      summaryStatus: "failed",
      summaryModel: null,
      summarizedAt: input.now,
      error: message.slice(0, 240),
      updatedAt: input.now,
    })
    return {
      resultRef: `failed:${message.slice(0, 120)}`,
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(failed)),
    }
  }
}

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
