import { readFile } from "node:fs/promises"
import { SignJWT } from "jose"
import { STAGING_TEST_JWT_AUDIENCE, STAGING_TEST_JWT_ISSUER } from "../src/lib/auth/staging-test-auth"

type Json = Record<string, unknown>

const apiBase = "https://api-staging.pirate.sc"
let communityId = ""
const subject = "story-e2e-author-1780678999641-65820e"
const adminToken = requiredEnv("PIRATE_ADMIN_TOKEN")
const stagingSecret = requiredEnv("STAGING_TEST_JWT_SHARED_SECRET")

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(result).set(bytes)
  return result
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Json
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is not a string`)
  return value
}

function rows(value: unknown, label: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value.map((entry, index) => object(entry, `${label}[${index}]`))
}

async function request(input: {
  path: string
  method?: string
  token?: string
  admin?: boolean
  body?: Json
  bytes?: Uint8Array
  contentType?: string
}): Promise<Json> {
  const response = await fetch(`${apiBase}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.admin ? { "x-admin-token": adminToken } : {}),
      ...((input.body || input.bytes) ? { "content-type": input.contentType ?? "application/json" } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : input.bytes ? arrayBuffer(input.bytes) : undefined,
  })
  const text = await response.text()
  let parsed: Json
  try {
    parsed = text ? object(JSON.parse(text), "response") : {}
  } catch {
    parsed = { raw: text }
  }
  if (!response.ok) throw new Error(`${input.method ?? "GET"} ${input.path} -> ${response.status}: ${JSON.stringify(parsed).slice(0, 1500)}`)
  return parsed
}

async function mintSession(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(STAGING_TEST_JWT_ISSUER)
    .setAudience(STAGING_TEST_JWT_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(stagingSecret))
  const exchanged = await request({
    path: "/auth/session/exchange",
    method: "POST",
    body: { proof: { type: "staging_test_jwt", jwt } },
  })
  return string(exchanged.access_token, "access_token")
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(bytes))
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

async function uploadVideo(token: string, path: string, label: string): Promise<Json> {
  const bytes = new Uint8Array(await readFile(path))
  const contentHash = await sha256(bytes)
  const upload = await request({
    path: `/communities/${communityId}/song-artifact-uploads`,
    method: "POST",
    token,
    body: {
      upload_mode: "direct_multipart",
      artifact_kind: "primary_video",
      mime_type: "video/mp4",
      filename: `${label}.mp4`,
      size_bytes: bytes.byteLength,
      content_hash: contentHash,
    },
  })
  const uploadId = string(upload.id, "upload.id")
  const session = object(upload.upload_session, "upload_session")
  if (session.total_parts !== 1) throw new Error(`expected one upload part, got ${session.total_parts}`)
  const sessionId = string(session.id, "session.id")
  const signed = await request({
    path: `/communities/${communityId}/song-artifact-uploads/${uploadId}/sessions/${sessionId}/parts/1/signed-url`,
    token,
  })
  const put = await fetch(string(signed.url, "signed.url"), {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: arrayBuffer(bytes),
  })
  const etag = put.headers.get("etag")
  if (!put.ok || !etag) throw new Error(`multipart PUT failed: ${put.status}`)
  return request({
    path: `/communities/${communityId}/song-artifact-uploads/${uploadId}/sessions/${sessionId}/complete`,
    method: "POST",
    token,
    body: {
      upload_id: string(session.upload_id, "session.upload_id"),
      parts: [{ part_number: 1, etag }],
      content_hash: contentHash,
    },
  })
}

async function createVideo(token: string, upload: Json, label: string): Promise<Json> {
  return request({
    path: `/communities/${communityId}/posts`,
    method: "POST",
    token,
    body: {
      idempotency_key: `${label}-${Date.now()}`,
      post_type: "video",
      identity_mode: "public",
      title: label,
      visibility: "public",
      access_mode: "public",
      media_refs: [{
        storage_ref: string(upload.storage_ref, "upload.storage_ref"),
        mime_type: "video/mp4",
        size_bytes: upload.size_bytes,
        content_hash: upload.content_hash,
        duration_ms: 45_000,
      }],
    },
  })
}

async function evidence(postId: string): Promise<Json> {
  return request({
    path: `/admin/debug/video-audio-evidence?post_id=${encodeURIComponent(postId)}`,
    admin: true,
  })
}

async function poll(
  postId: string,
  predicate: (value: Json) => boolean,
  label: string,
  timeoutMs = 15 * 60_000,
): Promise<Json> {
  const deadline = Date.now() + timeoutMs
  let latest: Json = {}
  while (true) {
    if (Object.keys(latest).length > 0 && predicate(latest)) return latest
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out; latest=${JSON.stringify(latest).slice(0, 4000)}`)
    }
    await Bun.sleep(15_000)
    try {
      latest = await evidence(postId)
    } catch (error) {
      console.error(`${label} poll retry`, error instanceof Error ? error.message : String(error))
    }
  }
}

function analysisRows(value: Json): Json[] {
  return rows(value.analyses, "analyses")
}

function enrollment(value: Json): Json | null {
  for (const row of analysisRows(value)) {
    const signals = object(row.authenticity_signals ?? {}, "authenticity_signals")
    const record = signals.video_audio_catalog_enrollment
    if (record && typeof record === "object" && !Array.isArray(record)) return record as Json
  }
  return null
}

function hasVideoAudioMatch(value: Json): boolean {
  return analysisRows(value).some((row) => {
    const raw = JSON.stringify(row.acrcloud_custom_match ?? {})
    return raw.includes("video_audio")
  })
}

function compact(value: Json): Json {
  return {
    post: value.post,
    analyses: value.analyses,
    jobs: value.jobs,
    rights_review_cases: value.rights_review_cases,
    rights_holds: value.rights_holds,
  }
}

const version = await request({ path: "/__version" })
console.log("VERSION", JSON.stringify(version))
const token = await mintSession()
communityId = "com_cmt_125a93b013494cbd8ffd83bbfbbe4662"
const postAId = "post_pst_85ecb007dce948bdb0fec1c475067788"
console.log("COMMUNITY_RESUMED", JSON.stringify({ community_id: communityId }))
console.log("POST_A_RESUMED", JSON.stringify({ post_id: postAId }))
const evidenceA = await poll(postAId, (value) => Boolean(enrollment(value)?.file_id), "video A enrollment")
console.log("VIDEO_A_EVIDENCE", JSON.stringify(compact(evidenceA)))

await Bun.sleep(90_000)

const uploadB = await uploadVideo(token, "/tmp/pirate-video-b-e2e.mp4", "video-audio-e2e-b")
const postB = await createVideo(token, uploadB, "Video Audio E2E B")
const postBId = string(postB.id, "postB.id")
console.log("POST_B_CREATED", JSON.stringify({ post_id: postBId, asset_id: postB.asset, upload_id: uploadB.id }))
const evidenceB = await poll(postBId, hasVideoAudioMatch, "video B match")
const holdsB = rows(evidenceB.rights_holds, "rights_holds")
const casesB = rows(evidenceB.rights_review_cases, "rights_review_cases")
if (holdsB.length || casesB.length) throw new Error(`video B unexpectedly enforced: holds=${holdsB.length}, cases=${casesB.length}`)
console.log("VIDEO_B_EVIDENCE", JSON.stringify(compact(evidenceB)))

const publicPostB = await request({ path: `/public-posts/${encodeURIComponent(postBId)}` })
const feed = await request({ path: `/public-communities/${communityId}/posts?limit=50` })
const feedRaw = JSON.stringify(feed)
if (!feedRaw.includes(postBId)) throw new Error("video B is absent from the public community feed")
console.log("VIDEO_B_VISIBILITY", JSON.stringify({ public_post_id: publicPostB.id, feed_contains_post: true }))

await request({
  path: `/communities/${communityId}/posts/${encodeURIComponent(postAId)}/delete`,
  method: "POST",
  token,
})
const deletedA = await poll(postAId, (value) => {
  for (const row of analysisRows(value)) {
    const signals = object(row.authenticity_signals ?? {}, "authenticity_signals")
    const record = signals.video_audio_catalog_unenrollment
    if (record && typeof record === "object" && !Array.isArray(record)) {
      return ["deleted", "already_missing"].includes(String((record as Json).outcome))
    }
  }
  return false
}, "video A unenrollment")
console.log("VIDEO_A_TOMBSTONE", JSON.stringify(compact(deletedA)))
