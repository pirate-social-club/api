import type { ActorContext } from "../auth-middleware"
import { getCommunityRepository } from "../communities/db-community-repository"
import { openCommunityReadClient } from "../communities/community-read-access"
import { nowIso } from "../helpers"
import { canStudyPost, getStudyPostById } from "../posts/post-study-access"
import { decodePublicSongArtifactBundleId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import { findUploadedSongArtifactByStorageRef, getSongArtifactBundle } from "../song-artifacts/song-artifact-repository"
import { fetchSongArtifactBytes } from "../song-artifacts/song-artifact-storage"
import type { Env } from "../../env"
import { sendTelegramAudio } from "./bot-api"
import type { TelegramCommunityBotCredential } from "./community-bot-service"

const PLAYBACK_CALLBACK_PREFIX = "study-play"

export function telegramStudyPlaybackCallbackData(sessionId: string): string {
  return `${PLAYBACK_CALLBACK_PREFIX}:${sessionId}`
}

export function parseTelegramStudyPlaybackCallback(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null
  return value.match(/^study-play:(tcs_[A-Za-z0-9_-]+)$/u)?.[1] ?? null
}

export function telegramStudyPlaybackButton(sessionId: string) {
  return {
    callback_data: telegramStudyPlaybackCallbackData(sessionId),
    text: "🎵 Play song",
  }
}

async function cachedFileId(input: {
  botId: string
  contentHash: string
  env: Env
}): Promise<string | null> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT telegram_file_id
      FROM telegram_audio_file_cache
      WHERE telegram_community_bot_id = ?1 AND content_hash = ?2
      LIMIT 1
    `,
    args: [input.botId, input.contentHash],
  })
  const value = result.rows[0]?.telegram_file_id
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function removeCachedFileId(input: {
  botId: string
  contentHash: string
  env: Env
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `DELETE FROM telegram_audio_file_cache
          WHERE telegram_community_bot_id = ?1 AND content_hash = ?2`,
    args: [input.botId, input.contentHash],
  })
}

async function rememberFileId(input: {
  botId: string
  contentHash: string
  env: Env
  fileId: string
}): Promise<void> {
  const timestamp = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_audio_file_cache (
        telegram_community_bot_id, content_hash, telegram_file_id, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(telegram_community_bot_id, content_hash) DO NOTHING
    `,
    args: [input.botId, input.contentHash, input.fileId, timestamp],
  })
}

function normalizedContentHash(value: unknown): string | null {
  const hash = typeof value === "string" ? value.trim().toLowerCase() : ""
  return /^(?:0x)?[a-f0-9]{64}$/u.test(hash) ? hash.replace(/^0x/u, "") : null
}

async function performerName(env: Env, authorUserId: string | null): Promise<string | undefined> {
  if (!authorUserId) return undefined
  const result = await getControlPlaneClient(env).execute({
    sql: `
      SELECT COALESCE(NULLIF(TRIM(profile.display_name), ''), linked.label_display, handle.label_display) AS performer
      FROM profiles profile
      LEFT JOIN linked_handles linked ON linked.linked_handle_id = profile.primary_linked_handle_id
      LEFT JOIN global_handles handle ON handle.global_handle_id = profile.global_handle_id
      WHERE profile.user_id = ?1
      LIMIT 1
    `,
    args: [authorUserId],
  }).catch(() => null)
  const value = result?.rows[0]?.performer
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export async function sendTelegramStudySongPlayback(input: {
  actor: ActorContext
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  postId: string
}): Promise<boolean> {
  const community = await openCommunityReadClient(
    input.env,
    getCommunityRepository(input.env),
    input.bot.communityId,
  )
  try {
    const post = await getStudyPostById(community.client, input.postId)
    if (
      !post
      || post.community_id !== input.bot.communityId
      || !post.song_artifact_bundle_id
      || !await canStudyPost({
        actor: input.actor,
        client: community.client,
        communityId: input.bot.communityId,
        post,
      })
    ) {
      return false
    }

    const controlPlane = getControlPlaneClient(input.env)
    const bundleId = decodePublicSongArtifactBundleId(post.song_artifact_bundle_id)
    const bundle = await getSongArtifactBundle(controlPlane, input.bot.communityId, bundleId)
    const contentHash = normalizedContentHash(bundle?.primary_audio.content_hash)
    if (!bundle || !contentHash) return false

    const title = bundle.title?.trim() || post.song_title?.trim() || post.title?.trim() || "Untitled song"
    const performer = await performerName(input.env, post.author_user_id)
    const cached = await cachedFileId({ botId: input.bot.id, contentHash, env: input.env })
    if (cached) {
      try {
        await sendTelegramAudio(input.bot, {
          audio: cached,
          chat_id: input.chatId,
          performer,
          title,
        })
        return true
      } catch {
        await removeCachedFileId({ botId: input.bot.id, contentHash, env: input.env })
      }
    }

    const upload = await findUploadedSongArtifactByStorageRef({
      artifactKind: "primary_audio",
      client: controlPlane,
      communityId: input.bot.communityId,
      storageRef: bundle.primary_audio.storage_ref,
    })
    if (!upload || normalizedContentHash(upload.content_hash) !== contentHash) return false
    const playbackUrl = upload.gateway_url?.trim() || bundle.primary_audio.storage_ref.trim()
    const response = upload.storage_object_key
      ? await fetchSongArtifactBytes({ env: input.env, objectKey: upload.storage_object_key })
      : /^https?:\/\//u.test(playbackUrl)
        ? await fetch(playbackUrl)
        : null
    if (!response) return false
    if (!response.ok) return false
    const bytes = await response.arrayBuffer()
    const mimeType = upload.mime_type?.trim() || bundle.primary_audio.mime_type?.trim() || "audio/mpeg"
    const filename = upload.filename?.trim() || `${title}.mp3`
    const sent = await sendTelegramAudio(input.bot, {
      audio: new File([bytes], filename, { type: mimeType }),
      chat_id: input.chatId,
      performer,
      title,
    })
    const fileId = sent.audio?.file_id?.trim()
    if (fileId) {
      await rememberFileId({ botId: input.bot.id, contentHash, env: input.env, fileId })
    }
    return true
  } finally {
    community.close()
  }
}
