/**
 * Staging operator smoke for the song submit transport path.
 *
 * Requires an already-exchanged Pirate access token for a user who can post in
 * the target community. For the current incident this is normally minted with:
 *
 *   infisical run ... -- bun scripts/mint-staging-test-token.ts --exchange
 */

type Json = Record<string, unknown>

export {}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function requireArg(name: string): string {
  const value = arg(name)?.trim()
  if (!value) {
    console.error(`missing --${name}`)
    process.exit(1)
  }
  return value
}

function stripPublicId(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", body)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function requestJson(input: {
  method?: string
  url: string
  token: string
  body?: Json
}): Promise<Json> {
  const res = await fetch(input.url, {
    method: input.method ?? "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  })
  const text = await res.text()
  let parsed: Json
  try {
    parsed = text ? JSON.parse(text) as Json : {}
  } catch {
    parsed = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`${input.method ?? "POST"} ${input.url} -> ${res.status}: ${JSON.stringify(parsed).slice(0, 1200)}`)
  }
  return parsed
}

function asObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`)
  }
  return value as Json
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} was not a non-empty string`)
  }
  return value
}

const apiBase = (arg("api-base") ?? "https://api-staging.pirate.sc").replace(/\/$/, "")
const token = requireArg("token")
const communityId = stripPublicId(requireArg("community"), "com_")
const publicCommunityId = `com_${communityId}`

const audioBytes = new TextEncoder().encode(`pirate staging song submit smoke ${new Date().toISOString()}\n`)
const contentHash = `0x${await sha256Hex(audioBytes)}`
const idempotencySuffix = `${Date.now()}`

console.log("[smoke] target", { apiBase, community: publicCommunityId, size: audioBytes.byteLength, contentHash })

const upload = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/song-artifact-uploads`,
  token,
  body: {
    upload_mode: "direct_multipart",
    artifact_kind: "primary_audio",
    mime_type: "audio/mpeg",
    filename: `staging-song-smoke-${idempotencySuffix}.mp3`,
    size_bytes: audioBytes.byteLength,
    content_hash: contentHash,
  },
})
const uploadId = asString(upload.id, "upload.id")
const session = asObject(upload.upload_session, "upload.upload_session")
const sessionId = asString(session.id, "upload_session.id")
const uploadIdForFilebase = asString(session.upload_id, "upload_session.upload_id")
const totalParts = Number(session.total_parts)
console.log("[smoke] upload intent", { uploadId, sessionId, uploadIdForFilebase, totalParts })

if (totalParts !== 1) {
  throw new Error(`expected tiny smoke upload to have 1 part, got ${totalParts}`)
}

const signed = await requestJson({
  method: "GET",
  url: `${apiBase}/communities/${publicCommunityId}/song-artifact-uploads/${uploadId}/sessions/${sessionId}/parts/1/signed-url`,
  token,
})
const signedUrl = asString(signed.url, "signed.url")
console.log("[smoke] signed part url minted")

const put = await fetch(signedUrl, {
  method: "PUT",
  headers: { "content-type": "audio/mpeg" },
  body: audioBytes,
})
const etag = put.headers.get("etag")
if (!put.ok || !etag) {
  throw new Error(`Filebase part PUT failed: ${put.status}; etag=${etag}; body=${(await put.text()).slice(0, 800)}`)
}
console.log("[smoke] filebase part uploaded", { status: put.status, etag })

const completed = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/song-artifact-uploads/${uploadId}/sessions/${sessionId}/complete`,
  token,
  body: {
    upload_id: uploadIdForFilebase,
    parts: [{ part_number: 1, etag }],
    content_hash: contentHash,
  },
})
console.log("[smoke] multipart complete", {
  status: completed.status,
  ipfs_cid: completed.ipfs_cid ?? null,
  content_hash: completed.content_hash ?? null,
})

const bundle = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/song-artifacts`,
  token,
  body: {
    primary_audio: { song_artifact_upload: uploadId },
    title: `Staging Song Smoke ${idempotencySuffix}`,
    lyrics: "Transport smoke.",
  },
})
const bundleId = asString(bundle.id, "bundle.id")
console.log("[smoke] bundle created", { bundleId, preview_status: bundle.preview_status ?? null })

const post = await requestJson({
  url: `${apiBase}/communities/${publicCommunityId}/posts`,
  token,
  body: {
    idempotency_key: `staging-song-smoke-${idempotencySuffix}`,
    post_type: "song",
    identity_mode: "public",
    title: `Staging Song Smoke ${idempotencySuffix}`,
    song_mode: "original",
    rights_basis: "original",
    license_preset: "non-commercial",
    access_mode: "public",
    song_artifact_bundle: bundleId,
  },
})

console.log("[smoke] post created", {
  id: post.id ?? null,
  status: post.status ?? null,
  song_artifact_bundle: post.song_artifact_bundle ?? null,
  asset: post.asset ?? null,
})
