import { readFile } from "node:fs/promises"
import { basename, extname, resolve } from "node:path"
import { createClient } from "@libsql/client"
import { SignJWT } from "jose"
import { sha256Hex } from "../src/lib/crypto"
import { makeId, nowIso } from "../src/lib/helpers"
import {
  createSongArtifactBundleDraft,
  finalizeSongArtifactBundle,
  markSongArtifactUploadUploaded,
  requireSongArtifactUpload,
} from "../src/lib/song-artifacts/song-artifact-repository"
import { descriptorFromUpload } from "../src/lib/song-artifacts/song-artifact-descriptors"
import { LOCAL_DEV_SONG_ARTIFACT_STORAGE_PROVIDER } from "../src/lib/song-artifacts/song-artifact-storage-provider"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import { readDevVarsFromCwd } from "./_lib/dev-vars"

type HttpMethod = "GET" | "POST" | "PUT"

type ApiResult<T> = {
  body: T
  status: number
}

const devVars = readDevVarsFromCwd()
const env: Record<string, string | undefined> = {
  ...devVars,
  ...process.env,
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function logStep(message: string): void {
  console.log(`[live-room:e2e] ${message}`)
}

function envValue(name: string, fallback = ""): string {
  return env[name]?.trim() || fallback
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "")
}

function rawId(value: string, prefix: string): string {
  return value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : value
}

function isLocalApiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
  } catch {
    return false
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from API response`)
  }
  return value.trim()
}

async function requestJson<T>(input: {
  apiUrl: string
  body?: unknown
  contentType?: string
  method?: HttpMethod
  ok?: number[]
  path: string
  token?: string
}): Promise<ApiResult<T>> {
  const method = input.method ?? (input.body == null ? "GET" : "POST")
  const timeoutMs = Number(readArg("--request-timeout-ms") || "60000")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined

  if (input.token) headers.authorization = `Bearer ${input.token}`
  if (input.body != null) {
    if (input.body instanceof Uint8Array) {
      const binaryBody = new ArrayBuffer(input.body.byteLength)
      new Uint8Array(binaryBody).set(input.body)
      body = binaryBody
      headers["content-type"] = input.contentType ?? "application/octet-stream"
    } else {
      body = JSON.stringify(input.body)
      headers["content-type"] = input.contentType ?? "application/json"
    }
  }

  try {
    const response = await fetch(`${input.apiUrl}${input.path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null
    const ok = input.ok ?? [200, 201, 202]
    if (!ok.includes(response.status)) {
      throw new Error(`${method} ${input.path} failed with ${response.status}: ${text}`)
    }
    return { body: parsed as T, status: response.status }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${method} ${input.path} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function mintDevJwt(subject: string): Promise<string> {
  const issuer = (envValue("AUTH_UPSTREAM_JWT_ISSUER") || envValue("JWT_BASED_AUTH_ISSUERS", "pirate-dev")).split(",")[0]!.trim()
  const audience = envValue("AUTH_UPSTREAM_JWT_AUDIENCE") || envValue("JWT_BASED_AUTH_AUDIENCE", "pirate-api")
  const secret = envValue("AUTH_UPSTREAM_JWT_SHARED_SECRET") || envValue("JWT_BASED_AUTH_SHARED_SECRET")
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET is required")

  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
}

function localControlPlaneDatabaseUrl(): string | null {
  const configured = envValue("CONTROL_PLANE_DATABASE_URL")
  if (!configured.startsWith("file:")) return null
  const path = configured.slice("file:".length)
  if (!path) return null
  return `file:${path.startsWith("/") ? path : resolve(process.cwd(), path)}`
}

async function markLocalUserVerified(userId: string, apiUrl: string): Promise<void> {
  if (envValue("ENVIRONMENT") !== "development" || !isLocalApiUrl(apiUrl)) {
    throw new Error("Local verification fallback is only allowed for development localhost API runs")
  }

  const databaseUrl = localControlPlaneDatabaseUrl()
  if (!databaseUrl) {
    throw new Error("Local verification fallback requires file: CONTROL_PLANE_DATABASE_URL")
  }

  const nowIso = new Date().toISOString()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const capabilities = buildDefaultVerificationCapabilities()
  capabilities.unique_human = {
    state: "verified",
    provider: "self",
    proof_type: "unique_human",
    mechanism: "local_e2e",
    verified_at: nowSeconds,
  }

  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        UPDATE users
        SET verification_state = 'verified',
            capability_provider = 'self',
            verification_capabilities_json = ?1,
            verified_at = ?2,
            updated_at = ?2
        WHERE user_id = ?3
      `,
      args: [JSON.stringify(capabilities), nowIso, userId],
    })
    if (result.rowsAffected !== 1) {
      throw new Error(`Local verification fallback could not find user ${userId}`)
    }
  } finally {
    client.close()
  }
}

async function completeLocalVerification(input: {
  accessToken: string
  apiUrl: string
  userId: string
}): Promise<void> {
  try {
    await requestJson<{ id: string }>({
      apiUrl: input.apiUrl,
      path: "/verification-sessions",
      token: input.accessToken,
      body: { provider: "self" },
    }).then((started) => requestJson({
      apiUrl: input.apiUrl,
      path: `/verification-sessions/${encodeURIComponent(requireString(started.body.id, "verification id"))}/complete`,
      token: input.accessToken,
      body: {},
    }))
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("Self provider requires a public HTTPS callback origin")) {
      throw error
    }
  }

  await markLocalUserVerified(input.userId, input.apiUrl)
}

async function createFastLocalSongArtifactBundle(input: {
  apiUrl: string
  communityId: string
  lyrics: string
  title: string
  uploadId: string
  userId: string
}): Promise<{ id: string; title: string }> {
  if (envValue("ENVIRONMENT") !== "development" || !isLocalApiUrl(input.apiUrl)) {
    throw new Error("Fast local song bundle fallback is only allowed for development localhost API runs")
  }

  const databaseUrl = localControlPlaneDatabaseUrl()
  if (!databaseUrl) {
    throw new Error("Fast local song bundle fallback requires file: CONTROL_PLANE_DATABASE_URL")
  }

  const client = createClient({ url: databaseUrl })
  try {
    const upload = await requireSongArtifactUpload(client, input.communityId, rawId(input.uploadId, "sau"))
    const createdAt = nowIso()
    const songArtifactBundleId = makeId("sab")
    await createSongArtifactBundleDraft({
      client,
      communityId: input.communityId,
      userId: input.userId,
      songArtifactBundleId,
      body: {
        primary_audio: { song_artifact_upload: input.uploadId },
        title: input.title,
        lyrics: input.lyrics,
      },
      primaryAudio: descriptorFromUpload(env, upload),
      coverArt: null,
      previewAudio: null,
      canvasVideo: null,
      instrumentalAudio: null,
      vocalAudio: null,
      lyricsSha256: `0x${await sha256Hex(input.lyrics)}`,
      geniusAnnotationsUrl: null,
      previewStatus: "completed",
      createdAt,
    })
    const finalized = await finalizeSongArtifactBundle({
      client,
      communityId: input.communityId,
      songArtifactBundleId,
      status: "ready",
      translationStatus: "pending",
      translationError: null,
      translatedLyricsRef: null,
      translatedLyrics: null,
      alignmentStatus: "completed",
      alignmentError: null,
      alignmentReason: null,
      timedLyricsRef: null,
      timedLyrics: null,
      moderationStatus: "completed",
      moderationError: null,
      moderationResultRef: null,
      moderationResult: {
        provider: "local_e2e",
        analysis_state: "allow",
        content_safety_state: "safe",
        age_gate_policy: "none",
      },
      previewStatus: "completed",
      previewError: null,
      updatedAt: nowIso(),
    })
    return { id: finalized.id, title: finalized.title }
  } finally {
    client.close()
  }
}

async function markFastLocalSongArtifactUploadUploaded(input: {
  apiUrl: string
  bytes: Uint8Array
  communityId: string
  mimeType: string
  uploadId: string
}): Promise<void> {
  if (envValue("ENVIRONMENT") !== "development" || !isLocalApiUrl(input.apiUrl)) {
    throw new Error("Fast local upload fallback is only allowed for development localhost API runs")
  }

  const databaseUrl = localControlPlaneDatabaseUrl()
  if (!databaseUrl) {
    throw new Error("Fast local upload fallback requires file: CONTROL_PLANE_DATABASE_URL")
  }

  const rawUploadId = rawId(input.uploadId, "sau")
  const client = createClient({ url: databaseUrl })
  try {
    await markSongArtifactUploadUploaded({
      client,
      communityId: input.communityId,
      songArtifactUploadId: rawUploadId,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      contentHash: `0x${await sha256Hex(input.bytes)}`,
      storageProvider: LOCAL_DEV_SONG_ARTIFACT_STORAGE_PROVIDER,
      storageBucket: "local-dev",
      storageObjectKey: `song-artifacts/${input.communityId}/${rawUploadId}`,
      storageEndpoint: "local-dev://song-artifacts",
      gatewayUrl: `${input.apiUrl}/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(rawUploadId)}/content`,
      ipfsCid: null,
      updatedAt: nowIso(),
    })
  } finally {
    client.close()
  }
}

function makeSilentWavBytes(durationSeconds = 1): Uint8Array {
  const sampleRate = 8000
  const channelCount = 1
  const bytesPerSample = 2
  const sampleCount = sampleRate * durationSeconds
  const dataSize = sampleCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)

  return new Uint8Array(buffer)
}

function inferAudioMimeType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".flac":
      return "audio/flac"
    case ".m4a":
      return "audio/mp4"
    case ".mp3":
      return "audio/mpeg"
    case ".ogg":
      return "audio/ogg"
    case ".wav":
      return "audio/wav"
    default:
      return "audio/wav"
  }
}

async function readAudioBytes(): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
  const audioFile = readArg("--audio-file")
  if (!audioFile) {
    return {
      bytes: makeSilentWavBytes(),
      filename: "live-room-local-e2e.wav",
      mimeType: "audio/wav",
    }
  }
  const bytes = new Uint8Array(await readFile(audioFile))
  const filename = basename(audioFile) || "live-room-audio"
  const mimeType = readArg("--audio-mime") || inferAudioMimeType(filename)
  return { bytes, filename, mimeType }
}

async function main(): Promise<void> {
  const apiUrl = stripTrailingSlash(readArg("--api-url") || envValue("PIRATE_API_URL", "http://127.0.0.1:8787"))
  const webUrl = stripTrailingSlash(readArg("--web-url") || envValue("PIRATE_WEB_PUBLIC_ORIGIN", "http://localhost:5173"))
  const subject = readArg("--subject") || `live-room-local-e2e-${Date.now()}`
  const title = readArg("--title") || "Live Room Local E2E Song"
  const artist = readArg("--artist") || "Local E2E Artist"
  const lyrics = readArg("--lyrics") || "Local line for the live room smoke test."
  const communityName = readArg("--community-name") || "Live Room Local E2E"
  const dryRun = hasFlag("--dry-run")
  const realSongAnalysis = hasFlag("--real-song-analysis")

  if (dryRun) {
    console.log("live-room local E2E dry run")
    console.log(`apiUrl=${apiUrl}`)
    console.log(`webUrl=${webUrl}`)
    console.log(`subject=${subject}`)
    return
  }

  logStep("minting local dev JWT")
  const jwt = await mintDevJwt(subject)
  logStep("exchanging JWT for Pirate session")
  const exchange = await requestJson<{
    access_token: string
    user: { id?: string; user_id?: string }
  }>({
    apiUrl,
    path: "/auth/session/exchange",
    body: { proof: { type: "jwt_based_auth", jwt } },
  })
  const accessToken = requireString(exchange.body.access_token, "access_token")
  const publicUserId = requireString(exchange.body.user.id ?? exchange.body.user.user_id, "user.id")
  const userId = rawId(publicUserId, "usr")

  logStep("completing local verification")
  await completeLocalVerification({ accessToken, apiUrl, userId })

  logStep("creating local community")
  const community = await requestJson<{ community: { id: string } }>({
    apiUrl,
    path: "/communities",
    token: accessToken,
    body: {
      display_name: communityName,
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    },
    ok: [202],
  })
  const communityId = rawId(requireString(community.body.community.id, "community.id"), "com")

  logStep("preparing audio upload")
  const audio = await readAudioBytes()
  logStep("creating song artifact upload intent")
  const upload = await requestJson<{ id: string }>({
    apiUrl,
    path: `/communities/${encodeURIComponent(communityId)}/song-artifact-uploads`,
    token: accessToken,
    body: {
      artifact_kind: "primary_audio",
      mime_type: audio.mimeType,
      filename: audio.filename,
      size_bytes: audio.bytes.byteLength,
    },
    ok: [201],
  })
  const uploadId = requireString(upload.body.id, "song artifact upload id")

  if (isLocalApiUrl(apiUrl) && !realSongAnalysis) {
    logStep("marking fast local song artifact content uploaded")
    await markFastLocalSongArtifactUploadUploaded({
      apiUrl,
      communityId,
      uploadId,
      bytes: audio.bytes,
      mimeType: audio.mimeType,
    })
  } else {
    logStep("uploading song artifact content")
    await requestJson({
      apiUrl,
      method: "PUT",
      path: `/communities/${encodeURIComponent(communityId)}/song-artifact-uploads/${encodeURIComponent(uploadId)}/content`,
      token: accessToken,
      body: audio.bytes,
      contentType: "application/octet-stream",
    })
  }

  logStep(isLocalApiUrl(apiUrl) && !realSongAnalysis
    ? "creating fast local song artifact bundle"
    : "creating song artifact bundle with analysis")
  const bundle = isLocalApiUrl(apiUrl) && !realSongAnalysis
    ? await createFastLocalSongArtifactBundle({
        apiUrl,
        communityId,
        userId,
        uploadId,
        title,
        lyrics,
      })
    : await requestJson<{ id: string; title: string }>({
        apiUrl,
        path: `/communities/${encodeURIComponent(communityId)}/song-artifacts`,
        token: accessToken,
        body: {
          primary_audio: { song_artifact_upload: uploadId },
          title,
          lyrics,
        },
        ok: [201],
      }).then((result) => result.body)
  const bundleId = requireString(bundle.id, "song artifact bundle id")

  logStep("checking live setlist picker search")
  await requestJson({
    apiUrl,
    path: `/communities/${encodeURIComponent(communityId)}/song-artifacts?q=${encodeURIComponent(title)}&limit=10`,
    token: accessToken,
  })

  logStep("creating ready live room")
  const room = await requestJson<{
    anchor_post: string
    id: string
    setlist: { items: Array<{ song_artifact_bundle: string | null }> }
  }>({
    apiUrl,
    path: `/communities/${encodeURIComponent(communityId)}/live-rooms`,
    token: accessToken,
    body: {
      title: "Local E2E Live Room",
      room_kind: "solo",
      access_mode: "free",
      visibility: "public",
      performer_allocations: [
        { role: "host", user: `usr_${userId}`, share_bps: 10000 },
      ],
      setlist: {
        status: "ready",
        items: [
          {
            song_artifact_bundle: bundleId,
            title,
            artist,
            rights_basis: "original",
            rights_status: "ready",
          },
        ],
      },
    },
    ok: [201],
  })
  const liveRoomId = requireString(room.body.id, "live room id")
  const anchorPostId = requireString(room.body.anchor_post, "anchor post id")
  const anchorPostUrl = `${webUrl}/p/${encodeURIComponent(anchorPostId)}`
  const freedomUrl = `freedom://live-room?roomId=${encodeURIComponent(liveRoomId)}&communityId=${encodeURIComponent(communityId)}&apiBase=${encodeURIComponent(apiUrl)}`

  console.log("Live room local E2E seed complete")
  console.log("")
  console.log(`User: ${publicUserId}`)
  console.log(`Community: com_${communityId}`)
  console.log(`Song artifact bundle: ${bundleId}`)
  console.log(`Live room: ${liveRoomId}`)
  console.log(`Anchor post: ${anchorPostId}`)
  console.log("")
  console.log("Open the anchor post:")
  console.log(anchorPostUrl)
  console.log("")
  console.log("Open in Freedom:")
  console.log(freedomUrl)
  console.log("")
  console.log("Manual checks:")
  console.log("1. In Freedom, click Sign in and approve the device in the web page.")
  console.log("2. Click Host Attach.")
  console.log("3. Confirm JackTrip fields populate from the attach payload.")
  console.log("4. Click End Room and confirm the room transitions to ended.")
  console.log("")
  console.log("Notes:")
  console.log("- Set PIRATE_WEB_PUBLIC_ORIGIN=http://localhost:5173 on the API for device auth links.")
  console.log("- Set LIVE_ROOM_JACKTRIP_HOST or LIVE_ROOM_JACKTRIP_HOST_TEMPLATE for JackTrip auto-connect.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
