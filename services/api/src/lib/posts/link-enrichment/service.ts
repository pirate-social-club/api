import type { Env } from "../../../env"
import type { Client } from "../../sql-client"
import { fetchLinkPreviewMetadata } from "../link-preview-fetcher"
import { updatePostLinkPreviewMetadata } from "../community-post-store"
import { enqueueCommunityJob } from "../../communities/jobs/store"
import type { DbExecutor } from "../../db-helpers"
import { fetchFirecrawlLinkEnrichment } from "./firecrawl-provider"
import {
  buildLinkEnrichmentSnapshot,
  getLinkEnrichmentByNormalizedUrl,
  upsertLinkEnrichment,
  upsertLinkEnrichmentUsage,
} from "./repository"
import { normalizeLinkUrl } from "./url-normalization"
import type { LinkEnrichmentRecord } from "./types"

async function materializeSnapshot(input: {
  client: DbExecutor
  controlPlaneClient?: Client | null
  communityId?: string | null
  postId: string
  record: LinkEnrichmentRecord
  syncedAt: string
}): Promise<void> {
  const snapshot = buildLinkEnrichmentSnapshot(input.record)
  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.postId,
    linkOgImageUrl: input.record.image_url,
    linkOgTitle: input.record.title,
    linkEnrichmentSnapshotJson: JSON.stringify(snapshot),
    linkEnrichmentSyncedAt: input.syncedAt,
    updatedAt: input.syncedAt,
  })
  if (input.controlPlaneClient && input.communityId) {
    await upsertLinkEnrichmentUsage({
      client: input.controlPlaneClient,
      normalizedUrl: input.record.normalized_url,
      communityId: input.communityId,
      postId: input.postId,
      linkEnrichmentId: input.record.link_enrichment_id,
      snapshotSyncedAt: input.syncedAt,
      now: input.syncedAt,
    })
  }
}

async function enqueueSummaryIfNeeded(input: {
  communityClient: DbExecutor
  communityId?: string | null
  postId: string
  record: LinkEnrichmentRecord
  createdAt: string
}): Promise<void> {
  if (!input.communityId || !input.record.markdown?.trim()) {
    return
  }
  if (input.record.summary_status === "ready" || input.record.summary_status === "pending") {
    return
  }
  await enqueueCommunityJob({
    client: input.communityClient,
    communityId: input.communityId,
    jobType: "link_summary_materialize",
    subjectType: "link_enrichment",
    subjectId: input.record.normalized_url,
    payloadJson: JSON.stringify({
      normalized_url: input.record.normalized_url,
      post_id: input.postId,
    }),
    createdAt: input.createdAt,
  })
}

export async function hydrateGenericLinkEnrichment(input: {
  env?: Env
  controlPlaneClient?: Client | null
  communityClient: DbExecutor
  communityId?: string | null
  postId: string
  url: string
  checkedAt: string
  fetcher: typeof fetch
}): Promise<string | null> {
  const normalizedUrl = normalizeLinkUrl(input.url)
  const canUseFirecrawl = Boolean(
    normalizedUrl
      && input.env?.FIRECRAWL_API_KEY?.trim()
      && input.controlPlaneClient,
  )

  if (canUseFirecrawl && normalizedUrl && input.controlPlaneClient) {
    const cached = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, normalizedUrl)
    if (cached?.status === "ready") {
      await materializeSnapshot({
        client: input.communityClient,
        controlPlaneClient: input.controlPlaneClient,
        communityId: input.communityId,
        postId: input.postId,
        record: cached,
        syncedAt: input.checkedAt,
      })
      await enqueueSummaryIfNeeded({
        communityClient: input.communityClient,
        communityId: input.communityId,
        postId: input.postId,
        record: cached,
        createdAt: input.checkedAt,
      })
      return cached.image_url ?? cached.title ?? cached.normalized_url
    }

    const firecrawl = await fetchFirecrawlLinkEnrichment({
      env: input.env!,
      fetcher: input.fetcher,
      url: input.url,
    })
    if (firecrawl?.ok) {
      const record = await upsertLinkEnrichment({
        client: input.controlPlaneClient,
        normalizedUrl,
        canonicalUrl: firecrawl.canonicalUrl ?? normalizedUrl,
        provider: "firecrawl",
        status: "ready",
        title: firecrawl.title,
        description: firecrawl.description,
        publisher: firecrawl.publisher,
        publishedAt: firecrawl.publishedAt,
        imageUrl: firecrawl.imageUrl,
        markdown: firecrawl.markdown,
        error: null,
        fetchedAt: input.checkedAt,
        now: input.checkedAt,
      })
      await materializeSnapshot({
        client: input.communityClient,
        controlPlaneClient: input.controlPlaneClient,
        communityId: input.communityId,
        postId: input.postId,
        record,
        syncedAt: input.checkedAt,
      })
      await enqueueSummaryIfNeeded({
        communityClient: input.communityClient,
        communityId: input.communityId,
        postId: input.postId,
        record,
        createdAt: input.checkedAt,
      })
      return record.image_url ?? record.title ?? record.normalized_url
    }

    if (firecrawl && !firecrawl.ok) {
      await upsertLinkEnrichment({
        client: input.controlPlaneClient,
        normalizedUrl,
        canonicalUrl: normalizedUrl,
        provider: "firecrawl",
        status: "failed",
        title: null,
        description: null,
        publisher: null,
        publishedAt: null,
        imageUrl: null,
        markdown: null,
        error: firecrawl.error,
        fetchedAt: input.checkedAt,
        now: input.checkedAt,
      })
    }
  }

  const metadata = await fetchLinkPreviewMetadata({
    fetcher: input.fetcher,
    url: input.url,
  })
  if (!metadata.imageUrl && !metadata.title) {
    return null
  }

  if (normalizedUrl && input.controlPlaneClient) {
    const record = await upsertLinkEnrichment({
      client: input.controlPlaneClient,
      normalizedUrl,
      canonicalUrl: normalizedUrl,
      provider: "native",
      status: "ready",
      title: metadata.title,
      description: null,
      publisher: null,
      publishedAt: null,
      imageUrl: metadata.imageUrl,
      markdown: null,
      error: null,
      fetchedAt: input.checkedAt,
      now: input.checkedAt,
    })
    await materializeSnapshot({
      client: input.communityClient,
      controlPlaneClient: input.controlPlaneClient,
      communityId: input.communityId,
      postId: input.postId,
      record,
      syncedAt: input.checkedAt,
    })
  } else {
    await updatePostLinkPreviewMetadata({
      client: input.communityClient,
      postId: input.postId,
      linkOgImageUrl: metadata.imageUrl,
      linkOgTitle: metadata.title,
      updatedAt: input.checkedAt,
    })
  }

  return metadata.imageUrl ?? metadata.title
}
