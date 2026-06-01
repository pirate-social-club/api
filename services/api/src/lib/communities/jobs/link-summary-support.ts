import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../../localization/content-locale"
import { logPipelineError, sanitizeLogText, summarizeUrl } from "../../observability/pipeline-log"
import { getLinkEnrichmentByNormalizedUrl } from "../../posts/link-enrichment/repository"
import { upsertLinkEnrichmentUsage } from "../../posts/link-enrichment/repository-usages"
import {
  listLinkSummaryFanoutUsages,
  markLinkSummaryFanoutSynced,
  writeLinkEnrichmentSnapshotToPost,
} from "../../posts/link-enrichment/summary-fanout"
import { getControlPlaneClient } from "../../runtime-deps"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityJobHandlerInput } from "./handler-types"
import { enqueueCommunityJob } from "./store"

export function resolvePayloadPostId(payload: { post_id?: string | null } | null): string | null {
  return typeof payload?.post_id === "string" && payload.post_id.trim()
    ? payload.post_id.trim()
    : null
}

export async function registerOriginatingPost(input: {
  controlPlaneClient: ReturnType<typeof getControlPlaneClient>
  normalizedUrl: string
  communityId: string
  postId: string | null
  now: string
}): Promise<void> {
  if (!input.postId) {
    return
  }
  await upsertLinkEnrichmentUsage({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
    communityId: input.communityId,
    postId: input.postId,
    linkEnrichmentId: null,
    snapshotSyncedAt: null,
    now: input.now,
  })
}

export async function fanoutLinkSummarySnapshot(input: {
  handlerInput: CommunityJobHandlerInput
  controlPlaneClient: ReturnType<typeof getControlPlaneClient>
  normalizedUrl: string
  snapshotJson: string
  syncedAt: string
  logPrefix: string
  locale?: string | null
}): Promise<{ synced: number; failed: number }> {
  const usages = await listLinkSummaryFanoutUsages({
    controlPlaneClient: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
  })
  let synced = 0
  let failed = 0
  for (const usage of usages) {
    try {
      const db = await openCommunityDb(input.handlerInput.env, input.handlerInput.communityRepository, usage.community_id)
      try {
        await writeLinkEnrichmentSnapshotToPost({
          client: db.client,
          postId: usage.post_id,
          snapshotJson: input.snapshotJson,
          syncedAt: input.syncedAt,
        })
        await markLinkSummaryFanoutSynced({
          controlPlaneClient: input.controlPlaneClient,
          normalizedUrl: input.normalizedUrl,
          communityId: usage.community_id,
          postId: usage.post_id,
          syncedAt: input.syncedAt,
        })
        synced += 1
      } finally {
        db.close()
      }
    } catch (error) {
      failed += 1
      logPipelineError(`${input.logPrefix} failed to fan out enrichment snapshot`, {
        normalized_url: summarizeUrl(input.normalizedUrl),
        ...(input.locale ? { locale: input.locale } : {}),
        community_id: usage.community_id,
        post_id: usage.post_id,
        error: sanitizeLogText(error instanceof Error ? error.message : String(error)),
      })
    }
  }
  return { synced, failed }
}

export async function enqueueSummaryTranslations(input: {
  handlerInput: CommunityJobHandlerInput
  controlPlaneClient: ReturnType<typeof getControlPlaneClient>
  normalizedUrl: string
  payloadPostId: string | null
  now: string
}): Promise<void> {
  const queueDb = await openCommunityDb(
    input.handlerInput.env,
    input.handlerInput.communityRepository,
    input.handlerInput.job.community_id,
  )
  try {
    const record = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
    for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
      if (sameLanguageLocale("en", locale) && sameLanguageLocale(record?.source_language, "en")) {
        continue
      }
      await enqueueCommunityJob({
        client: queueDb.client,
        communityId: input.handlerInput.job.community_id,
        jobType: "link_summary_translation_materialize",
        subjectType: "link_enrichment_translation",
        subjectId: `${input.normalizedUrl}:${locale}`,
        payloadJson: JSON.stringify({
          normalized_url: input.normalizedUrl,
          locale,
          post_id: input.payloadPostId,
        }),
        createdAt: input.now,
      })
    }
  } finally {
    queueDb.close()
  }
}
