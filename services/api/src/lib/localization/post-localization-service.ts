import { executeFirst, type DbExecutor } from "../db-helpers"
import { getCommunityLabelById, serializeCommunityPostLabel } from "../communities/community-label-store"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import { resolvePostStudyCapability } from "../posts/post-study-service"
import { computePostSourceHash, computeTextSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { getContentTranslation } from "./content-translation-store"
import type { CommentThreadSnapshot, LocalizedPostResponse, Post, SongPresentationDownloadableAudio } from "../../types"
import type { Env } from "../../env"

type DecentralizedStorageProof = NonNullable<SongPresentationDownloadableAudio["decentralized_storage"]>
type SongPresentationAlignmentStatus = NonNullable<LocalizedPostResponse["song_presentation"]>["alignment_status"]
type StudyEnabledCache = Map<string, Promise<boolean>>
type StudyElevenLabsCredentialResolver = (communityId: string) => Promise<boolean>

const DEFAULT_IPFS_GATEWAY_URL = "https://dweb.link/ipfs"

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function alignmentStatusValue(value: unknown): SongPresentationAlignmentStatus {
  const status = stringValue(value)
  switch (status) {
    case "pending":
    case "processing":
    case "completed":
    case "failed":
      return status
    default:
      return null
  }
}

function parseDecentralizedStorageProof(value: unknown): SongPresentationDownloadableAudio["decentralized_storage"] {
  if (!value || typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>
  const cid = stringValue(record.cid)
  const gatewayUrl = stringValue(record.gateway_url)
  if (record.provider !== "filebase_ipfs" || !cid || !gatewayUrl) {
    return null
  }

  return {
    provider: "filebase_ipfs",
    cid,
    gateway_url: gatewayUrl,
    ...(record.encrypted === true ? { encrypted: true } : {}),
  }
}

function parseAudioDescriptor(value: unknown): Omit<SongPresentationDownloadableAudio, "kind"> | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>
  const storageRef = stringValue(record.storage_ref)
  const mimeType = stringValue(record.mime_type)
  if (!storageRef || !mimeType) {
    return null
  }

  return {
    storage_ref: storageRef,
    mime_type: mimeType,
    size_bytes: numberValue(record.size_bytes),
    duration_ms: numberValue(record.duration_ms),
    filename: stringValue(record.filename),
    decentralized_storage: parseDecentralizedStorageProof(record.decentralized_storage),
  }
}

function parseJsonAudioDescriptor(value: unknown): Omit<SongPresentationDownloadableAudio, "kind"> | null {
  if (typeof value !== "string") {
    return parseAudioDescriptor(value)
  }

  if (!value.trim()) {
    return null
  }

  try {
    return parseAudioDescriptor(JSON.parse(value))
  } catch {
    return null
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value
  }
  if (!value.trim()) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function hasTimedLyricsLine(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasTimedLyricsLine)
  }
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  if (
    Array.isArray(record.words)
    || record.start_ms !== undefined
    || record.end_ms !== undefined
    || record.startMs !== undefined
    || record.endMs !== undefined
    || record.start !== undefined
    || record.end !== undefined
    || record.text !== undefined
    || record.original_text !== undefined
  ) {
    return true
  }

  return hasTimedLyricsLine(
    record.raw_lines
      ?? record.rawLines
      ?? record.full_karaoke_lines
      ?? record.fullKaraokeLines
      ?? record.lines
      ?? record.lyrics
      ?? record.segments,
  )
}

function hasTimedLyrics(input: {
  inline: unknown
  ref: unknown
}): boolean {
  if (stringValue(input.ref)) {
    return true
  }

  return hasTimedLyricsLine(parseJsonValue(input.inline))
}

function buildDefaultIpfsGatewayUrl(cid: string): string {
  return `${DEFAULT_IPFS_GATEWAY_URL}/${encodeURIComponent(cid)}`
}

function parseSongArtifactUploadIdFromStorageRef(storageRef: string): string | null {
  try {
    const url = new URL(storageRef, "https://pirate.local")
    const segments = url.pathname.split("/").map((segment) => decodeURIComponent(segment))
    const uploadSegmentIndex = segments.indexOf("song-artifact-uploads")
    if (uploadSegmentIndex === -1) {
      return null
    }
    return stringValue(segments[uploadSegmentIndex + 1])
  } catch {
    return null
  }
}

async function enrichDownloadableAudioWithUploadProofs(input: {
  executor: DbExecutor
  post: Post
  entries: SongPresentationDownloadableAudio[]
}): Promise<SongPresentationDownloadableAudio[]> {
  const uploadIds = [...new Set(input.entries
    .filter((entry) => !entry.decentralized_storage)
    .map((entry) => parseSongArtifactUploadIdFromStorageRef(entry.storage_ref))
    .filter((value): value is string => Boolean(value)))]

  if (!uploadIds.length) {
    return input.entries
  }

  const placeholders = uploadIds.map((_, index) => `?${index + 2}`).join(", ")
  const result = await input.executor.execute({
    sql: `
      SELECT song_artifact_upload_id, ipfs_cid
      FROM song_artifact_uploads
      WHERE community_id = ?1
        AND song_artifact_upload_id IN (${placeholders})
        AND ipfs_cid IS NOT NULL
        AND ipfs_cid <> ''
    `,
    args: [input.post.community_id, ...uploadIds],
  })
  const proofByUploadId = new Map<string, DecentralizedStorageProof>()
  for (const row of result.rows) {
    const uploadId = stringValue(row.song_artifact_upload_id)
    const cid = stringValue(row.ipfs_cid)
    if (!uploadId || !cid) {
      continue
    }
    proofByUploadId.set(uploadId, {
      provider: "filebase_ipfs",
      cid,
      gateway_url: buildDefaultIpfsGatewayUrl(cid),
    })
  }

  if (!proofByUploadId.size) {
    return input.entries
  }

  return input.entries.map((entry) => {
    if (entry.decentralized_storage) {
      return entry
    }
    const uploadId = parseSongArtifactUploadIdFromStorageRef(entry.storage_ref)
    const proof = uploadId ? proofByUploadId.get(uploadId) : null
    return proof ? { ...entry, decentralized_storage: proof } : entry
  })
}

async function getPublicDownloadableAudio(input: {
  executor: DbExecutor
  post: Post
}): Promise<{
  alignment_status: SongPresentationAlignmentStatus
  downloadable_audio: SongPresentationDownloadableAudio[] | null
  has_timed_lyrics: boolean
} | null> {
  const accessMode = input.post.access_mode ?? "public"
  if (
    input.post.post_type !== "song"
    || accessMode !== "public"
    || !input.post.song_artifact_bundle_id
  ) {
    return null
  }

  const row = await executeFirst(input.executor, {
    sql: `
      SELECT primary_audio_json, instrumental_audio_json, vocal_audio_json,
             alignment_status, timed_lyrics_ref, timed_lyrics_json
      FROM song_artifact_bundles
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
      LIMIT 1
    `,
    args: [input.post.community_id, input.post.song_artifact_bundle_id],
  }) as Record<string, unknown> | null

  if (!row) {
    return null
  }

  const entries: SongPresentationDownloadableAudio[] = []
  const original = parseJsonAudioDescriptor(row.primary_audio_json)
  if (original) {
    entries.push({ kind: "original", ...original })
  }

  const instrumental = parseJsonAudioDescriptor(row.instrumental_audio_json)
  if (instrumental) {
    entries.push({ kind: "instrumental", ...instrumental })
  }

  const vocals = parseJsonAudioDescriptor(row.vocal_audio_json)
  if (vocals) {
    entries.push({ kind: "vocals", ...vocals })
  }

  const downloadableAudio = entries.length
    ? await enrichDownloadableAudioWithUploadProofs({
        executor: input.executor,
        post: input.post,
        entries,
      })
    : null

  return {
    alignment_status: alignmentStatusValue(row.alignment_status),
    downloadable_audio: downloadableAudio,
    has_timed_lyrics: hasTimedLyrics({
      inline: row.timed_lyrics_json,
      ref: row.timed_lyrics_ref,
    }),
  }
}

async function buildSongPresentation(input: {
  songArtifactExecutor?: DbExecutor | null
  post: Post
}): Promise<LocalizedPostResponse["song_presentation"]> {
  if (input.post.post_type !== "song") {
    return null
  }

  const postTitle = stringValue(input.post.song_title)
  const postCoverArtRef = stringValue(input.post.song_cover_art_ref)
  const postDurationMs = numberValue(input.post.song_duration_ms)
  const artifactPresentation = input.songArtifactExecutor
    ? await getPublicDownloadableAudio({
        executor: input.songArtifactExecutor,
        post: input.post,
      })
    : null
  return postTitle || postCoverArtRef || postDurationMs !== null || artifactPresentation
    ? {
        title: postTitle,
        cover_art_ref: postCoverArtRef,
        duration_ms: postDurationMs,
        downloadable_audio: artifactPresentation?.downloadable_audio ?? null,
        alignment_status: artifactPresentation?.alignment_status ?? null,
        has_timed_lyrics: artifactPresentation?.has_timed_lyrics ?? null,
      }
    : null
}

function enrichSongPostMediaRefs(input: {
  post: Post
  songPresentation: LocalizedPostResponse["song_presentation"]
}): Post {
  if (input.post.post_type !== "song" || !input.post.media_refs?.length) {
    return input.post
  }

  const originalAudio = input.songPresentation?.downloadable_audio?.find((item) => item.kind === "original")
  const proof = originalAudio?.decentralized_storage
  if (!proof) {
    return input.post
  }

  const targetIndex = input.post.media_refs.findIndex((ref) => ref.storage_ref === originalAudio.storage_ref)
  const mediaRefIndex = targetIndex === -1 ? 0 : targetIndex
  const currentRef = input.post.media_refs[mediaRefIndex]
  if (!currentRef || currentRef.decentralized_storage) {
    return input.post
  }

  return {
    ...input.post,
    media_refs: input.post.media_refs.map((ref, index) => (
      index === mediaRefIndex
        ? { ...ref, decentralized_storage: proof }
        : ref
    )),
  }
}

export type PostReadMetrics = {
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}

async function getAuthorCommunityRole(input: {
  executor: DbExecutor
  post: Pick<Post, "author_user_id" | "community_id" | "identity_mode">
}): Promise<LocalizedPostResponse["author_community_role"]> {
  if (input.post.identity_mode !== "public" || !input.post.author_user_id) {
    return null
  }

  const result = await input.executor.execute({
    sql: `
      SELECT role
      FROM community_roles
      WHERE community_id = ?1
        AND user_id = ?2
        AND status = 'active'
        AND role IN ('owner', 'admin', 'moderator')
      ORDER BY CASE role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        ELSE 2
      END
      LIMIT 1
    `,
    args: [input.post.community_id, input.post.author_user_id],
  })
  const role = result.rows[0]?.role
  if (role === "owner") return "owner"
  if (role === "admin" || role === "moderator") return "moderator"
  return null
}

async function buildStudyCapability(input: {
  executor: DbExecutor
  env?: Env | null
  post: Post
  resolvedLocale: string
  studyElevenLabsCredentialResolver?: StudyElevenLabsCredentialResolver
  studyEnabledCache?: StudyEnabledCache
  viewerUserId: string | null | undefined
}): Promise<LocalizedPostResponse["study_capability"]> {
  if (input.post.post_type !== "song") {
    return null
  }

  let studyEnabled = input.studyEnabledCache?.get(input.post.community_id)
  if (!studyEnabled) {
    studyEnabled = isCommunityStudyEnabled({
      executor: input.executor,
      communityId: input.post.community_id,
    })
    input.studyEnabledCache?.set(input.post.community_id, studyEnabled)
  }
  if (!await studyEnabled) {
    return null
  }

  return resolvePostStudyCapability({
    client: input.executor,
    env: input.env,
    hasActiveElevenLabsCredential: input.studyElevenLabsCredentialResolver,
    post: input.post,
    targetLanguage: input.resolvedLocale,
    viewerUserId: input.viewerUserId,
  })
}

type PredictionMarketEmbed = NonNullable<Post["embeds"]>[number] & {
  preview?: {
    question?: string | null
    title?: string | null
    outcomes?: Array<{
      label?: string | null
    }> | null
  } | null
}

function getPredictionMarketEmbedQuestion(embed: NonNullable<Post["embeds"]>[number]): string | null {
  if (embed.provider !== "kalshi" && embed.provider !== "polymarket") {
    return null
  }
  const preview = (embed as PredictionMarketEmbed).preview
  const question = String(preview?.question ?? preview?.title ?? "").trim()
  return question || null
}

function getTranslatableMarketEmbeds(post: Post): Array<{
  embedKey: string
  question: string
  outcomes: Array<{ index: number; label: string }>
}> {
  return (post.embeds ?? [])
    .map((embed) => {
      const preview = (embed as PredictionMarketEmbed).preview
      return {
        embedKey: embed.embed_key,
        question: getPredictionMarketEmbedQuestion(embed),
        outcomes: (preview?.outcomes ?? [])
          .map((outcome, index) => ({ index, label: String(outcome?.label ?? "").trim() }))
          .filter((outcome) => Boolean(outcome.label)),
      }
    })
    .filter((item): item is { embedKey: string; question: string; outcomes: Array<{ index: number; label: string }> } => Boolean(item.question))
}

function hasTranslatablePostContent(post: Post): boolean {
  return Boolean(
    String(post.title ?? "").trim()
    || String(post.body ?? "").trim()
    || String(post.caption ?? "").trim(),
  )
}

async function getLocalizedMarketEmbedTranslations(input: {
  executor: DbExecutor
  post: Post
  locale: string
}): Promise<{
  missingCount: number
  translations: LocalizedPostResponse["translated_embeds"]
}> {
  const marketEmbeds = getTranslatableMarketEmbeds(input.post)
  const translations: NonNullable<LocalizedPostResponse["translated_embeds"]> = []
  let missingCount = 0

  for (const embed of marketEmbeds) {
    const sourceHash = await computeTextSourceHash(embed.question)
    const cached = await getContentTranslation({
      executor: input.executor,
      contentType: "post",
      contentId: input.post.post_id,
      fieldKey: `embed:${embed.embedKey}:question`,
      locale: input.locale,
      sourceHash,
    })
    if (!cached) {
      missingCount += 1
      continue
    }
    if (cached.outcome === "translated") {
      const translatedOutcomes: NonNullable<NonNullable<LocalizedPostResponse["translated_embeds"]>[number]["translated_outcomes"]> = []
      for (const outcome of embed.outcomes) {
        const outcomeSourceHash = await computeTextSourceHash(outcome.label)
        const outcomeTranslation = await getContentTranslation({
          executor: input.executor,
          contentType: "post",
          contentId: input.post.post_id,
          fieldKey: `embed:${embed.embedKey}:outcome:${outcome.index}`,
          locale: input.locale,
          sourceHash: outcomeSourceHash,
        })
        if (!outcomeTranslation) {
          missingCount += 1
          continue
        }
        if (outcomeTranslation.outcome === "translated") {
          translatedOutcomes.push({
            label: outcome.label,
            translated_label: outcomeTranslation.translated_body,
            source_hash: outcomeSourceHash,
          })
        }
      }
      translations.push({
        embed_key: embed.embedKey,
        translated_question: cached.translated_body,
        translated_title: cached.translated_title,
        ...(translatedOutcomes.length ? { translated_outcomes: translatedOutcomes } : {}),
        source_hash: sourceHash,
      })
    }
  }

  return {
    missingCount,
    translations: translations.length ? translations : null,
  }
}

export async function buildLocalizedPostResponse(input: {
  executor: DbExecutor
  env?: Env | null
  songArtifactExecutor?: DbExecutor | null
  post: Post
  locale?: string | null
  metrics?: Partial<PostReadMetrics>
  threadSnapshot?: CommentThreadSnapshot | null
  ageGateViewerState?: "proof_required" | "verified_allowed" | null
  studyElevenLabsCredentialResolver?: StudyElevenLabsCredentialResolver
  studyEnabledCache?: StudyEnabledCache
  viewerUserId?: string | null
}): Promise<LocalizedPostResponse> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computePostSourceHash(input.post)
  const songPresentation = await buildSongPresentation({
    songArtifactExecutor: input.songArtifactExecutor,
    post: input.post,
  })
  const post = enrichSongPostMediaRefs({
    post: input.post,
    songPresentation,
  })
  const label = input.post.label_id
    ? await getCommunityLabelById({
        executor: input.executor,
        communityId: input.post.community_id,
        labelId: input.post.label_id,
      })
    : null

  const response: LocalizedPostResponse = {
    post,
    song_presentation: songPresentation,
    study_capability: await buildStudyCapability({
      executor: input.executor,
      env: input.env,
      post: input.post,
      resolvedLocale,
      studyElevenLabsCredentialResolver: input.studyElevenLabsCredentialResolver,
      studyEnabledCache: input.studyEnabledCache,
      viewerUserId: input.viewerUserId,
    }),
    author_community_role: await getAuthorCommunityRole({
      executor: input.executor,
      post: input.post,
    }),
    thread_snapshot: input.threadSnapshot ?? null,
    comment_count: input.metrics?.comment_count ?? input.threadSnapshot?.comment_count ?? 0,
    label: label ? serializeCommunityPostLabel(label) : null,
    upvote_count: input.metrics?.upvote_count ?? 0,
    downvote_count: input.metrics?.downvote_count ?? 0,
    like_count: input.metrics?.like_count ?? 0,
    viewer_vote: input.metrics?.viewer_vote ?? null,
    viewer_is_author: Boolean(input.viewerUserId && input.post.author_user_id === input.viewerUserId),
    viewer_reaction_kinds: [],
    age_gate_viewer_state: input.ageGateViewerState ?? null,
    resolved_locale: resolvedLocale,
    translation_state: "same_language",
    machine_translated: false,
    translated_title: null,
    translated_body: null,
    translated_caption: null,
    translated_embeds: null,
    source_hash: sourceHash,
  }

  const hasPostContent = hasTranslatablePostContent(input.post)
  const marketEmbedTranslations = await getLocalizedMarketEmbedTranslations({
    executor: input.executor,
    post: input.post,
    locale: resolvedLocale,
  })

  if (!hasPostContent && !input.post.embeds?.some((embed) => getPredictionMarketEmbedQuestion(embed))) {
    return response
  }

  if (sameLanguageLocale(input.post.source_language, resolvedLocale)) {
    return response
  }

  const translationPolicy = input.post.translation_policy ?? "none"
  if (translationPolicy === "none" || translationPolicy === "human_only") {
    return {
      ...response,
      translation_state: "policy_blocked",
    }
  }

  const cached = await getContentTranslation({
    executor: input.executor,
    contentType: "post",
    contentId: input.post.post_id,
    locale: resolvedLocale,
    sourceHash,
  })

  if ((hasPostContent && !cached) || marketEmbedTranslations.missingCount > 0) {
    return {
      ...response,
      translation_state: "pending",
      translated_embeds: marketEmbedTranslations.translations,
    }
  }

  if (!hasPostContent || cached?.outcome === "same_language") {
    return {
      ...response,
      translation_state: marketEmbedTranslations.translations?.length ? "ready" : response.translation_state,
      machine_translated: Boolean(marketEmbedTranslations.translations?.length),
      translated_embeds: marketEmbedTranslations.translations,
    }
  }

  return {
    ...response,
    translation_state: "ready",
    machine_translated: true,
    translated_title: cached?.translated_title,
    translated_body: cached?.translated_body,
    translated_caption: cached?.translated_caption,
    translated_embeds: marketEmbedTranslations.translations,
  }
}
