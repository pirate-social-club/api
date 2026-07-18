import { internalError } from "../../errors"
import { nowIso } from "../../helpers"
import {
  generateAndStoreLinkSummary,
  translateAndStoreLinkSummary,
} from "../../posts/link-enrichment/summary-service"
import { getControlPlaneClient } from "../../runtime-deps"
import { getLinkEnrichmentByNormalizedUrl } from "../../posts/link-enrichment/repository"
import { computeLinkSummaryTranslationSourceHash } from "../../posts/link-enrichment/translation-source-hash"
import type { CommunityJobHandlerInput } from "./handler-types"
import {
  enqueueSummaryTranslations,
  fanoutLinkSummarySnapshot,
  registerOriginatingPost,
  resolvePayloadPostId,
} from "./link-summary-support"
import { parseJobPayload } from "./payload"

type LinkSummaryMaterializePayload = {
  normalized_url?: string | null
  post_id?: string | null
}

type LinkSummaryTranslationMaterializePayload = {
  normalized_url?: string | null
  locale?: string | null
  post_id?: string | null
  source_hash?: string | null
}

export async function runLinkSummaryMaterialize(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<LinkSummaryMaterializePayload>(input.job.payload_json)
  const normalizedUrl = String(payload?.normalized_url ?? input.job.subject_id).trim()
  if (!normalizedUrl) {
    throw internalError("Link summary job is missing normalized URL")
  }
  if (!input.env.CONTROL_PLANE_DATABASE_URL) {
    throw internalError("Control-plane database is missing for link summary materialize")
  }

  const controlPlaneClient = getControlPlaneClient(input.env)
  const now = nowIso()
  const summary = await generateAndStoreLinkSummary({
    env: input.env,
    controlPlaneClient,
    normalizedUrl,
    now,
  })
  if (!summary.snapshotJson) {
    return summary.resultRef
  }

  const postId = resolvePayloadPostId(payload)
  await registerOriginatingPost({
    controlPlaneClient,
    normalizedUrl,
    communityId: input.job.community_id,
    postId,
    now,
  })

  const { synced, failed } = await fanoutLinkSummarySnapshot({
    handlerInput: input,
    controlPlaneClient,
    normalizedUrl,
    snapshotJson: summary.snapshotJson,
    syncedAt: now,
    logPrefix: "[link-summary]",
  })

  if (summary.resultRef.startsWith("ready:") || summary.resultRef === "skipped:summary_ready") {
    await enqueueSummaryTranslations({
      handlerInput: input,
      controlPlaneClient,
      normalizedUrl,
      payloadPostId: postId,
      now,
    })
  }

  return `${summary.resultRef}:synced:${synced}:failed:${failed}`
}

export async function runLinkSummaryTranslationMaterialize(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<LinkSummaryTranslationMaterializePayload>(input.job.payload_json)
  const normalizedUrl = String(payload?.normalized_url ?? "").trim()
  const locale = String(payload?.locale ?? "").trim()
  if (!normalizedUrl || !locale) {
    throw internalError("Link summary translation job is missing normalized URL or locale")
  }
  if (!input.env.CONTROL_PLANE_DATABASE_URL) {
    throw internalError("Control-plane database is missing for link summary translation materialize")
  }

  const controlPlaneClient = getControlPlaneClient(input.env)
  if (payload?.source_hash) {
    const record = await getLinkEnrichmentByNormalizedUrl(controlPlaneClient, normalizedUrl)
    if (!record || payload.source_hash !== await computeLinkSummaryTranslationSourceHash(record)) {
      return `link_summary_translation_stale_source:${normalizedUrl}:${locale}`
    }
  }
  const now = nowIso()
  const translated = await translateAndStoreLinkSummary({
    env: input.env,
    controlPlaneClient,
    normalizedUrl,
    locale,
    now,
  })
  if (!translated.snapshotJson) {
    return translated.resultRef
  }

  await registerOriginatingPost({
    controlPlaneClient,
    normalizedUrl,
    communityId: input.job.community_id,
    postId: resolvePayloadPostId(payload),
    now,
  })

  const { synced, failed } = await fanoutLinkSummarySnapshot({
    handlerInput: input,
    controlPlaneClient,
    normalizedUrl,
    snapshotJson: translated.snapshotJson,
    syncedAt: now,
    logPrefix: "[link-summary-translation]",
    locale,
  })

  return `${translated.resultRef}:synced:${synced}:failed:${failed}`
}
