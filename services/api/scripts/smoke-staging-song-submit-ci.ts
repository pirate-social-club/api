/**
 * Self-contained, MANUAL staging smoke for the full song-submit path:
 * upstream-JWT auth → community create → direct-multipart upload → bundle →
 * post create → assert the post published WITH an asset (i.e. Story royalty
 * registration actually succeeded, not just that a post row exists).
 *
 * This performs a REAL Story IP registration and spends operator IP, so it is
 * intentionally NOT on a timer — run it on demand after changes to upload, post
 * creation, asset creation, Story registration, wallet funding, or deploy config.
 * See .github/workflows/staging-song-submit-smoke.yml (workflow_dispatch only).
 *
 * Auth reuses the same upstream-JWT path as the other staging smokes
 * (AUTH_UPSTREAM_JWT_SHARED_SECRET). Env:
 *   AUTH_UPSTREAM_JWT_SHARED_SECRET  (required)  shared secret for the upstream issuer
 *   PIRATE_SMOKE_API_BASE_URL        (optional)  default https://api-staging.pirate.sc
 *   PIRATE_SMOKE_SUBJECT             (optional)  JWT subject / test user id
 */

import {
  createSmokeCommunity,
  mintSmokeAccessToken,
} from "./staging-smoke-support"

type Json = Record<string, unknown>

const apiBase = (process.env.PIRATE_SMOKE_API_BASE_URL ?? "https://api-staging.pirate.sc").replace(/\/$/, "")
const subject = process.env.PIRATE_SMOKE_SUBJECT ?? "usr_song_submit_ci_smoke"
const suffix = `${Date.now()}`

function fail(message: string): never {
  console.error(`[song-smoke] FAIL: ${message}`)
  process.exit(1)
}

function asObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} was not an object`)
  return value as Json
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) fail(`${label} was not a non-empty string`)
  return value as string
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", body)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function requestJson(input: { method?: string; url: string; token?: string; body?: Json; okStatuses?: number[] }): Promise<Json> {
  const res = await fetch(input.url, {
    method: input.method ?? "POST",
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "content-type": "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  })
  const text = await res.text()
  let parsed: Json
  try {
    parsed = text ? (JSON.parse(text) as Json) : {}
  } catch {
    parsed = { raw: text }
  }
  const ok = input.okStatuses ?? [200, 201]
  if (!ok.includes(res.status)) {
    fail(`${input.method ?? "POST"} ${new URL(input.url).pathname} -> ${res.status}: ${JSON.stringify(parsed).slice(0, 1000)}`)
  }
  return parsed
}

async function mintAccessToken(): Promise<string> {
  return await mintSmokeAccessToken({ apiBase, subject, prefix: "song-smoke" })
}

console.log("[song-smoke] target", { apiBase, subject })

const token = await mintAccessToken()
console.log("[song-smoke] authenticated")

const created = await createSmokeCommunity({
  apiBase,
  token,
  displayName: `Song Submit CI Smoke ${suffix}`,
  description: "Ephemeral staging smoke community for the song-submit path.",
  prefix: "song-smoke",
})
const publicCommunityId = created.publicCommunityId
const communityId = created.communityId
console.log("[song-smoke] community created", { communityId })

const audioBytes = new TextEncoder().encode(`pirate song submit ci smoke ${new Date().toISOString()}\n`)
const contentHash = `0x${await sha256Hex(audioBytes)}`

const upload = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/song-artifact-uploads`,
  token,
  body: {
    upload_mode: "direct_multipart",
    artifact_kind: "primary_audio",
    mime_type: "audio/mpeg",
    filename: `song-submit-ci-${suffix}.mp3`,
    size_bytes: audioBytes.byteLength,
    content_hash: contentHash,
  },
})
const uploadId = asString(upload.id, "upload.id")
const session = asObject(upload.upload_session, "upload.upload_session")
const sessionId = asString(session.id, "upload_session.id")
const uploadIdForFilebase = asString(session.upload_id, "upload_session.upload_id")
if (Number(session.total_parts) !== 1) fail(`expected 1 part for a tiny smoke upload, got ${session.total_parts}`)

const signed = await requestJson({
  method: "GET",
  url: `${apiBase}/communities/${publicCommunityId}/song-artifact-uploads/${uploadId}/sessions/${sessionId}/parts/1/signed-url`,
  token,
})
const signedUrl = asString(signed.url, "signed.url")

const put = await fetch(signedUrl, { method: "PUT", headers: { "content-type": "audio/mpeg" }, body: audioBytes })
const etag = put.headers.get("etag")
if (!put.ok || !etag) fail(`Filebase part PUT failed: ${put.status}; etag=${etag}`)
console.log("[song-smoke] part uploaded")

await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/song-artifact-uploads/${uploadId}/sessions/${sessionId}/complete`,
  token,
  body: { upload_id: uploadIdForFilebase, parts: [{ part_number: 1, etag }], content_hash: contentHash },
})

const bundle = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/song-artifacts`,
  token,
  body: {
    primary_audio: { song_artifact_upload: uploadId },
    title: `Song Submit CI Smoke ${suffix}`,
    lyrics: "CI smoke.",
  },
})
const bundleId = asString(bundle.id, "bundle.id")
console.log("[song-smoke] bundle created", { bundleId })

const post = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/posts`,
  token,
  body: {
    idempotency_key: `song-submit-ci-${suffix}`,
    post_type: "song",
    identity_mode: "public",
    title: `Song Submit CI Smoke ${suffix}`,
    song_mode: "original",
    rights_basis: "original",
    license_preset: "non-commercial",
    access_mode: "public",
    song_artifact_bundle: bundleId,
  },
})

const postId = post.id ?? null
const status = post.status ?? null
const asset = post.asset ?? null
console.log("[song-smoke] post created", { id: postId, status, asset })

// The whole point: the post must publish WITH an asset. A published post whose
// asset failed to register is the exact consistency bug fixed in #167; a missing
// asset here means Story registration silently failed.
if (status !== "published") fail(`post status is "${status}", expected "published"`)
if (!asset) fail("post published without an asset — Story royalty registration did not succeed")

// "An asset exists" only proves registration RAN. It says nothing about what we
// registered, which is how #415 stayed invisible: Story registration fired while the
// preview job — the only thing that hash-verifies the primary audio — was still queued.
// mediaHash was therefore null, and because the canonical media block is all-or-nothing,
// mediaUrl + mediaHash + mediaType were ALL dropped from one-shot on-chain metadata. The
// song still played, because animation_url does not depend on the hash, so every check we
// had stayed green.
//
// #415's contract is: registration waits for verification. Assert it. The preview job is
// what sets content_hash_verified_at, so if the asset is registered the preview must have
// completed first.
const bundles = await requestJson({
  method: "GET",
  url: `${apiBase}/communities/${publicCommunityId}/song-artifacts`,
  token,
  okStatuses: [200],
}) as { items?: Array<{ id?: unknown; preview_status?: unknown }> }

const publishedBundle = (bundles.items ?? []).find((item) => item.id === bundleId)
if (!publishedBundle) fail(`song artifact bundle ${bundleId} not found after publish`)

if (publishedBundle.preview_status !== "completed") {
  fail(
    `asset was registered while the bundle preview_status was "${String(publishedBundle.preview_status)}" — `
    + "Story registration ran before the primary audio hash was verified, so the on-chain "
    + "metadata is missing mediaUrl/mediaHash/mediaType (regression of #415)",
  )
}

console.log("[song-smoke] PASS — song post published with a registered asset, hash-verified before registration")
