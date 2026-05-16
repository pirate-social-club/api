import type { Client } from "../../sql-client"
import { updatePostLinkPreviewMetadata } from "../community-post-link-preview-store"
import { enqueueCommunityJob } from "../../communities/jobs/store"
import type { DbExecutor } from "../../db-helpers"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../../localization/content-locale"
import { upsertLinkEnrichmentUsage } from "./repository-usages"
import { buildLinkEnrichmentSnapshot } from "./snapshot"
import type { LinkEnrichmentRecord } from "./types"

export async function materializeLinkEnrichmentSnapshot(input: {
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

export async function enqueueLinkSummaryIfNeeded(input: {
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

export async function enqueueLinkSummaryTranslationsIfNeeded(input: {
  communityClient: DbExecutor
  communityId?: string | null
  postId: string
  record: LinkEnrichmentRecord
  createdAt: string
}): Promise<void> {
  if (!input.communityId || input.record.summary_status !== "ready") {
    return
  }
  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale("en", locale) && sameLanguageLocale(input.record.source_language ?? "en", "en")) {
      continue
    }
    await enqueueCommunityJob({
      client: input.communityClient,
      communityId: input.communityId,
      jobType: "link_summary_translation_materialize",
      subjectType: "link_enrichment_translation",
      subjectId: `${input.record.normalized_url}:${locale}`,
      payloadJson: JSON.stringify({
        normalized_url: input.record.normalized_url,
        locale,
        post_id: input.postId,
      }),
      createdAt: input.createdAt,
    })
  }
}

export async function materializeLinkEnrichmentForPost(input: {
  communityClient: DbExecutor
  controlPlaneClient?: Client | null
  communityId?: string | null
  postId: string
  record: LinkEnrichmentRecord
  syncedAt: string
  enqueueSummary?: boolean
  enqueueTranslations?: boolean
}): Promise<void> {
  await materializeLinkEnrichmentSnapshot({
    client: input.communityClient,
    controlPlaneClient: input.controlPlaneClient,
    communityId: input.communityId,
    postId: input.postId,
    record: input.record,
    syncedAt: input.syncedAt,
  })
  if (input.enqueueSummary ?? true) {
    await enqueueLinkSummaryIfNeeded({
      communityClient: input.communityClient,
      communityId: input.communityId,
      postId: input.postId,
      record: input.record,
      createdAt: input.syncedAt,
    })
  }
  if (input.enqueueTranslations ?? true) {
    await enqueueLinkSummaryTranslationsIfNeeded({
      communityClient: input.communityClient,
      communityId: input.communityId,
      postId: input.postId,
      record: input.record,
      createdAt: input.syncedAt,
    })
  }
}
