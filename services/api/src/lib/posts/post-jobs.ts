import type { Client } from "../sql-client"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../localization/content-locale"
import { nowIso } from "../helpers"
import type { Community, LocalizedPostResponse, Post } from "../../types"

async function enqueuePostTranslationJob(input: {
  client: Client
  communityId: string
  postId: string
  locale: string
  createdAt: string
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "post_translation_materialize",
    subjectType: "post_translation",
    subjectId: `${input.postId}:${input.locale}`,
    payloadJson: JSON.stringify({
      post_id: input.postId,
      locale: input.locale,
    }),
    createdAt: input.createdAt,
  })
}

export async function enqueuePostTranslationPrewarmJobs(input: {
  client: Client
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  const translationPolicy = input.post.translation_policy ?? "none"
  if (translationPolicy !== "machine_allowed" && translationPolicy !== "hybrid") {
    return
  }

  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale(input.post.source_language, locale)) {
      continue
    }
    await enqueuePostTranslationJob({
      client: input.client,
      communityId: input.communityId,
      postId: input.post.post_id,
      locale,
      createdAt: input.createdAt,
    })
  }
}

export async function enqueuePostTranslationOnReadIfNeeded(input: {
  client: Client
  communityId: string
  response: LocalizedPostResponse
}): Promise<void> {
  const response = input.response
  const needsTranslationJob = response.translation_state === "pending"
    || (
      response.translation_state === "ready"
      && (
        (String(response.post.title ?? "").trim() && !String(response.translated_title ?? "").trim())
        || (String(response.post.body ?? "").trim() && !String(response.translated_body ?? "").trim())
        || (String(response.post.caption ?? "").trim() && !String(response.translated_caption ?? "").trim())
      )
    )
  if (!needsTranslationJob) {
    return
  }
  await enqueuePostTranslationJob({
    client: input.client,
    communityId: input.communityId,
    postId: response.post.post_id,
    locale: response.resolved_locale,
    createdAt: nowIso(),
  })
}

async function enqueuePostLabelJob(input: {
  client: Client
  communityId: string
  postId: string
  createdAt: string
  reason?: "publish" | "edit"
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "post_label_materialize",
    subjectType: "post_label",
    subjectId: input.postId,
    payloadJson: JSON.stringify({
      post_id: input.postId,
      reason: input.reason ?? "publish",
    }),
    createdAt: input.createdAt,
  })
}

export async function enqueueLinkPreviewFetchIfNeeded(input: {
  client: Client
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  if (input.post.post_type !== "link" || !input.post.link_url?.trim()) {
    return
  }

  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "link_preview_fetch",
    subjectType: "link_preview",
    subjectId: input.post.post_id,
    payloadJson: JSON.stringify({
      post_id: input.post.post_id,
      link_url: input.post.link_url,
    }),
    createdAt: input.createdAt,
  })
}

export async function enqueuePostLabelIfNeeded(input: {
  client: Client
  community: Pick<Community, "label_policy">
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  if (input.post.status !== "published") {
    return
  }

  const labelPolicy = input.community.label_policy
  const hasActiveDefinitions = Boolean(labelPolicy?.definitions.some((definition) => definition.status === "active"))
  if (!labelPolicy?.label_enabled || !hasActiveDefinitions) {
    return
  }

  await enqueuePostLabelJob({
    client: input.client,
    communityId: input.communityId,
    postId: input.post.post_id,
    createdAt: input.createdAt,
    reason: "publish",
  })
}
