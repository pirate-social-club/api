import { getControlPlaneClient } from "../runtime-deps"
import { HttpError, notFoundError, providerUnavailable } from "../errors"
import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import type { PostReadCommunityRepository } from "./post-read-context"
import { openProjectedPostCommunityDb } from "./post-read-context"
import {
  canReadNonPublishedPost,
  isPubliclyReadablePost,
  requireMemberAccess,
} from "./post-access"
import { getSongArtifactBundle } from "../song-artifacts/song-artifact-repository"
import { decodePublicSongArtifactBundleId, publicCommunityId, publicPostId } from "../public-ids"
import { openCommunityDb } from "../communities/community-db-factory"
import { getActiveEntitlementForBuyer } from "../communities/commerce/shared"
import { executeFirst, type DbExecutor } from "../db-helpers"
import type {
  Env,
  Post,
  SongKaraokeLine,
  SongKaraokePayload,
} from "../../types"

const TIMED_LYRICS_REF_TIMEOUT_MS = 3_000

type KaraokeTimingRecorder = (name: string, durationMs: number) => void

function recordKaraokeTiming(input: {
  recordTiming?: KaraokeTimingRecorder
}, name: string, startedAt: number): void {
  input.recordTiming?.(name, Math.round((performance.now() - startedAt) * 10) / 10)
}

async function timedKaraokeStep<T>(input: {
  recordTiming?: KaraokeTimingRecorder
}, name: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    recordKaraokeTiming(input, name, startedAt)
  }
}

function timedKaraokeSyncStep<T>(input: {
  recordTiming?: KaraokeTimingRecorder
}, name: string, fn: () => T): T {
  const startedAt = performance.now()
  try {
    return fn()
  } finally {
    recordKaraokeTiming(input, name, startedAt)
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function rawStringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//u.test(value)
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return ""
  }

  return String(value).replace(/\s+/gu, " ").trim()
}

function firstRawText(record: Record<string, unknown>): string {
  return rawStringValue(record.text)
    ?? rawStringValue(record.original_text)
    ?? rawStringValue(record.word)
    ?? ""
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string" || !value.trim()) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function msValue(record: Record<string, unknown>, msKeys: string[], secondKeys: string[]): number | null {
  for (const key of msKeys) {
    const value = numberValue(record[key])
    if (value !== null) {
      return Math.round(value)
    }
  }

  for (const key of secondKeys) {
    const value = numberValue(record[key])
    if (value !== null) {
      return Math.round(Math.abs(value) < 10_000 ? value * 1000 : value)
    }
  }

  return null
}

function timingRange(record: Record<string, unknown>): { endMs: number; startMs: number } | null {
  const startMs = msValue(record, ["start_ms", "startMs"], ["start"])
  const endMs = msValue(record, ["end_ms", "endMs"], ["end"])

  return startMs !== null && endMs !== null && endMs > startMs
    ? { endMs, startMs }
    : null
}

function stableLineId(input: {
  index: number
  kind: SongKaraokeLine["kind"]
  startMs: number
  text: string
}): string {
  let hash = 2166136261
  const value = `${input.kind}:${input.startMs}:${input.text}`
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `line-${input.index}-${input.startMs}-${(hash >>> 0).toString(36)}`
}

function isSectionMarker(text: string): boolean {
  return /^\[[^\]]+\]$/u.test(normalizeText(text))
}

type PlayableArtifactDescriptor = {
  decentralized_storage?: unknown
  gateway_url?: unknown
  storage_ref?: unknown
} | null | undefined

function toPlayableArtifactUrl(artifact: PlayableArtifactDescriptor): string | null {
  const storageRef = stringValue(artifact?.storage_ref)
  if (storageRef && (isHttpUrl(storageRef) || storageRef.startsWith("/"))) {
    return storageRef
  }

  const decentralized = isRecord(artifact?.decentralized_storage) ? artifact.decentralized_storage : null
  const gatewayUrl = stringValue(decentralized?.gateway_url) ?? stringValue((artifact as { gateway_url?: unknown } | null | undefined)?.gateway_url)
  return gatewayUrl && (isHttpUrl(gatewayUrl) || gatewayUrl.startsWith("/")) ? gatewayUrl : null
}

function nestedRawLines(value: Record<string, unknown>): unknown {
  return value.raw_lines
    ?? value.rawLines
    ?? value.full_karaoke_lines
    ?? value.fullKaraokeLines
    ?? value.lines
    ?? value.lyrics
    ?? value.segments
}

function isLikelyRawKaraokeLine(value: Record<string, unknown>): boolean {
  return Array.isArray(value.words)
    || value.start_ms !== undefined
    || value.end_ms !== undefined
    || value.startMs !== undefined
    || value.endMs !== undefined
    || value.start !== undefined
    || value.end !== undefined
    || value.text !== undefined
    || value.original_text !== undefined
}

function extractRawLines(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    const lines: Record<string, unknown>[] = []
    for (const item of value) {
      if (!isRecord(item)) continue
      if (isLikelyRawKaraokeLine(item)) {
        lines.push(item)
        continue
      }

      const nested = nestedRawLines(item)
      if (nested !== undefined) {
        lines.push(...extractRawLines(nested))
      }
    }
    return lines
  }

  if (!isRecord(value)) {
    return []
  }

  return extractRawLines(nestedRawLines(value))
}

type TimedTextEntry = {
  endMs: number
  rawText: string
  startMs: number
  text: string
}

function timedTextEntries(rawLines: Record<string, unknown>[]): TimedTextEntry[] {
  return rawLines
    .map((line) => {
      const range = timingRange(line)
      const rawText = firstRawText(line)
      const text = normalizeText(rawText)

      return range
        ? {
            endMs: range.endMs,
            rawText,
            startMs: range.startMs,
            text,
          }
        : null
    })
    .filter((entry): entry is TimedTextEntry => entry !== null)
    .sort((left, right) => left.startMs - right.startMs)
}

function looksLikeTokenStream(entries: TimedTextEntry[]): boolean {
  return entries.some((entry) => /[\r\n]/u.test(entry.rawText) || (entry.rawText.length > 0 && !entry.text))
}

function lyricSourceLines(lyrics: string | null | undefined): string[] {
  return (lyrics ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
}

function createKaraokeLine(input: {
  endMs: number
  index: number
  kind: SongKaraokeLine["kind"]
  startMs: number
  text: string
  words?: SongKaraokeLine["words"]
}): SongKaraokeLine {
  return {
    end_ms: input.endMs,
    id: stableLineId({
      index: input.index,
      kind: input.kind,
      startMs: input.startMs,
      text: input.text,
    }),
    index: input.index,
    kind: input.kind,
    start_ms: input.startMs,
    text: input.text,
    words: input.kind === "lyric"
      ? input.words?.length
        ? input.words
        : [{ end_ms: input.endMs, start_ms: input.startMs, text: input.text }]
      : [],
  }
}

function lineFromTimedEntry(entry: TimedTextEntry, index: number): SongKaraokeLine | null {
  if (!entry.text) {
    return null
  }

  const kind: SongKaraokeLine["kind"] = isSectionMarker(entry.text) ? "section" : "lyric"
  return createKaraokeLine({
    endMs: entry.endMs,
    index,
    kind,
    startMs: entry.startMs,
    text: entry.text,
  })
}

function buildLineShapedKaraokeLines(entries: TimedTextEntry[]): SongKaraokeLine[] {
  const lines: SongKaraokeLine[] = []

  for (const entry of entries) {
    const line = lineFromTimedEntry(entry, lines.length)
    if (line) {
      lines.push(line)
    }
  }

  return lines
}

function buildTokenStreamKaraokeLines(input: {
  entries: TimedTextEntry[]
  lyrics: string | null | undefined
}): SongKaraokeLine[] {
  const sourceLines = lyricSourceLines(input.lyrics)
  if (!sourceLines.length) {
    return []
  }

  const vocalTokens = input.entries.filter((entry) => entry.text && !isSectionMarker(entry.text))
  let cursor = 0
  const lines: SongKaraokeLine[] = []

  for (const sourceLine of sourceLines) {
    const kind: SongKaraokeLine["kind"] = isSectionMarker(sourceLine) ? "section" : "lyric"

    if (kind === "section") {
      const sectionEntry = input.entries.find((entry) => (
        isSectionMarker(entry.text)
        && entry.text.toLowerCase() === sourceLine.toLowerCase()
        && entry.startMs >= (lines.at(-1)?.end_ms ?? -1)
      ))
      if (sectionEntry) {
        lines.push(createKaraokeLine({
          endMs: sectionEntry.endMs,
          index: lines.length,
          kind,
          startMs: sectionEntry.startMs,
          text: sourceLine,
        }))
      }
      continue
    }

    const expectedWords = sourceLine.split(/\s+/u).filter(Boolean)
    if (!expectedWords.length) {
      continue
    }

    const words = vocalTokens
      .slice(cursor, cursor + expectedWords.length)
      .map((entry) => ({
        end_ms: entry.endMs,
        start_ms: entry.startMs,
        text: entry.text,
      }))
    cursor += words.length

    if (!words.length) {
      continue
    }

    const firstWord = words[0]
    const lastWord = words[words.length - 1]
    if (!firstWord || !lastWord) {
      continue
    }

    lines.push(createKaraokeLine({
      endMs: lastWord.end_ms,
      index: lines.length,
      kind,
      startMs: firstWord.start_ms,
      text: sourceLine,
      words,
    }))
  }

  return lines
}

export function buildSongKaraokeLines(input: {
  lyrics?: string | null
  timedLyrics: unknown
}): SongKaraokeLine[] {
  const entries = timedTextEntries(extractRawLines(input.timedLyrics))
  if (!entries.length) {
    return []
  }

  if (looksLikeTokenStream(entries)) {
    const groupedLines = buildTokenStreamKaraokeLines({
      entries,
      lyrics: input.lyrics,
    })
    if (groupedLines.length) {
      return groupedLines
    }
  }

  return buildLineShapedKaraokeLines(entries)
}

async function fetchJsonRef(ref: string): Promise<unknown | null> {
  if (!isHttpUrl(ref)) {
    return null
  }

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), TIMED_LYRICS_REF_TIMEOUT_MS)
  try {
    const response = await fetch(ref, {
      headers: { accept: "application/json" },
      signal: abort.signal,
    })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw providerUnavailable(`Timed lyrics fetch failed with status ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function resolveTimedLyrics(input: {
  inline: unknown
  ref?: string | null
}): Promise<unknown | null> {
  if (input.inline && typeof input.inline === "object") {
    return input.inline
  }

  const ref = stringValue(input.ref)
  return ref ? await fetchJsonRef(ref) : null
}

function shouldFallbackToPublicPostRead(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403 || error.status === 404)
}

type KaraokePostContext = {
  karaokeEnabled: boolean
  post: KaraokePost
  viewerIsAuthor: boolean
}

type KaraokePost = Pick<Post,
  | "access_mode"
  | "asset_id"
  | "author_user_id"
  | "community_id"
  | "lyrics"
  | "post_id"
  | "post_type"
  | "song_artifact_bundle_id"
  | "song_cover_art_ref"
  | "song_title"
  | "status"
  | "title"
  | "visibility"
> & {
  karaoke_enabled: number
}

async function getKaraokePostById(executor: DbExecutor, postId: string): Promise<KaraokePost | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT post_id, community_id, author_user_id, post_type, status,
             visibility, title, lyrics, song_artifact_bundle_id, song_cover_art_ref, song_title,
             access_mode, asset_id,
             (
               SELECT karaoke_enabled
               FROM communities
               WHERE communities.community_id = posts.community_id
               LIMIT 1
             ) AS karaoke_enabled
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  }) as Record<string, unknown> | null

  return row
    ? {
        access_mode: stringValue(row.access_mode) as Post["access_mode"],
        asset_id: stringValue(row.asset_id),
        author_user_id: stringValue(row.author_user_id),
        community_id: stringValue(row.community_id) ?? "",
        karaoke_enabled: Number(row.karaoke_enabled ?? 0),
        lyrics: stringValue(row.lyrics),
        post_id: stringValue(row.post_id) ?? "",
        post_type: stringValue(row.post_type) as Post["post_type"],
        song_artifact_bundle_id: stringValue(row.song_artifact_bundle_id),
        song_cover_art_ref: stringValue(row.song_cover_art_ref),
        song_title: stringValue(row.song_title),
        status: stringValue(row.status) as Post["status"],
        title: stringValue(row.title),
        visibility: stringValue(row.visibility) as Post["visibility"],
      }
    : null
}

async function loadAccessibleKaraokePost(input: {
  actor?: ActorContext | AdminActorContext | null
  communityId: string
  communityRepository: PostReadCommunityRepository
  env: Env
  locale?: string | null
  postId: string
  recordTiming?: KaraokeTimingRecorder
  profileRepository?: ProfileRepository | null
  userRepository: UserRepository
}): Promise<KaraokePostContext> {
  const db = await timedKaraokeStep(input, "post_open_db", () => openProjectedPostCommunityDb({
      env: input.env,
      communityRepository: input.communityRepository,
      postId: input.postId,
      requireLiveCommunity: !input.actor,
    }))

  try {
    const post = await timedKaraokeStep(input, "post_row", () => getKaraokePostById(db.client, input.postId))
    if (!post || post.community_id !== db.communityId) {
      throw notFoundError("Post not found")
    }

    const actor = input.actor
    if (actor) {
      try {
        const membership = await timedKaraokeStep(input, "post_member_access", () => requireMemberAccess(db.client, db.communityId, actor.userId))
        if (post.status !== "published" && !canReadNonPublishedPost(post, membership, actor.userId)) {
          throw notFoundError("Post not found")
        }
        return {
          karaokeEnabled: post.karaoke_enabled === 1,
          post,
          viewerIsAuthor: post.author_user_id === actor.userId,
        }
      } catch (error) {
        // Fall back to public reads so stale optional auth does not block public karaoke.
        if (!shouldFallbackToPublicPostRead(error)) {
          throw error
        }
      }
    }

    if (!isPubliclyReadablePost(post)) {
      throw notFoundError("Post not found")
    }

    return {
      karaokeEnabled: post.karaoke_enabled === 1,
      post,
      viewerIsAuthor: false,
    }
  } finally {
    db.close()
  }
}

async function canAccessKaraokeForPost(input: {
  actor?: ActorContext | AdminActorContext | null
  communityId: string
  communityRepository: PostReadCommunityRepository
  env: Env
  post: KaraokePostContext
}): Promise<boolean> {
  if (input.post.post.access_mode !== "locked") {
    return true
  }

  const actor = input.actor
  if (!actor) {
    return false
  }

  if (input.post.viewerIsAuthor || input.post.post.author_user_id === actor.userId) {
    return true
  }

  const assetId = stringValue(input.post.post.asset_id)
  if (!assetId) {
    return false
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const entitlement = await getActiveEntitlementForBuyer(db.client, input.communityId, actor.userId, assetId)
    return Boolean(entitlement)
  } finally {
    db.close()
  }
}

async function loadAccessiblePost(input: {
  actor?: ActorContext | AdminActorContext | null
  communityId: string
  communityRepository: PostReadCommunityRepository
  env: Env
  locale?: string | null
  postId: string
  profileRepository?: ProfileRepository | null
  userRepository: UserRepository
}): Promise<KaraokePostContext> {
  if (input.actor) {
    try {
      return await loadAccessibleKaraokePost(input)
    } catch (error) {
      // Fall back to public reads so stale optional auth does not block public karaoke.
      if (!shouldFallbackToPublicPostRead(error)) {
        throw error
      }
    }
  }

  return await loadAccessibleKaraokePost({
    ...input,
    actor: null,
  })
}

export async function getPostKaraokePayload(input: {
  actor?: ActorContext | AdminActorContext | null
  communityId: string
  communityRepository: PostReadCommunityRepository
  env: Env
  locale?: string | null
  postId: string
  profileRepository?: ProfileRepository | null
  recordTiming?: KaraokeTimingRecorder
  userRepository: UserRepository
}): Promise<SongKaraokePayload> {
  const postContext = await timedKaraokeStep(input, "post", () => loadAccessiblePost(input))
  const post = postContext.post
  if (post.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }
  if (!postContext.karaokeEnabled) {
    throw notFoundError("Karaoke is not available")
  }
  const songArtifactBundleId = post.song_artifact_bundle_id
  if (
    post.post_type !== "song"
    || !songArtifactBundleId
  ) {
    throw notFoundError("Karaoke is not available")
  }
  if (!await timedKaraokeStep(input, "access", () => canAccessKaraokeForPost({ ...input, post: postContext }))) {
    throw notFoundError("Karaoke is not available")
  }

  const bundle = await timedKaraokeStep(input, "bundle", () => getSongArtifactBundle(
      getControlPlaneClient(input.env),
      input.communityId,
      decodePublicSongArtifactBundleId(songArtifactBundleId),
    ),
  )
  if (
    !bundle
    || (bundle.status !== "ready" && bundle.status !== "consumed")
    || bundle.alignment_status !== "completed"
  ) {
    throw notFoundError("Karaoke is not available")
  }

  const instrumentalAudioUrl = toPlayableArtifactUrl(bundle.instrumental_audio)
  if (!instrumentalAudioUrl) {
    throw notFoundError("Karaoke is not available")
  }

  const timedLyrics = await timedKaraokeStep(input, "timed_lyrics", () => resolveTimedLyrics({
      inline: bundle.timed_lyrics,
      ref: bundle.timed_lyrics_ref,
    }))
  const rawLines = timedKaraokeSyncStep(input, "raw_lines", () => extractRawLines(timedLyrics))
  if (!rawLines.length) {
    throw notFoundError("Karaoke is not available")
  }
  const karaokeLines = timedKaraokeSyncStep(input, "karaoke_lines", () => buildSongKaraokeLines({
      lyrics: post.lyrics,
      timedLyrics,
    }))

  const postId = publicPostId(post.post_id)
  const artworkSrc = timedKaraokeSyncStep(input, "artwork", () => toPlayableArtifactUrl(bundle.cover_art)
      ?? toPlayableArtifactUrl({ storage_ref: post.song_cover_art_ref }))

  return {
    id: bundle.id,
    object: "song_karaoke_payload",
    song: bundle.id,
    post: postId,
    community: publicCommunityId(input.communityId),
    title: bundle.title || post.song_title || post.title || null,
    artwork_src: artworkSrc,
    instrumental_audio_url: instrumentalAudioUrl,
    karaoke_lines: karaokeLines,
    raw_lines: rawLines,
  }
}
