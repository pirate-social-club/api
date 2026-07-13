// @ts-nocheck

import { SignJWT } from "jose"
import { Interface, JsonRpcProvider, Wallet, getAddress } from "ethers"
// @ts-expect-error The API tsconfig only loads bun-types/test, but this script runs under Bun.
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"
import { STAGING_TEST_JWT_AUDIENCE, STAGING_TEST_JWT_ISSUER } from "../src/lib/auth/staging-test-auth"

type SmokeSession = {
  accessToken: string
  userId: string
  walletAddress: string
  walletAttachment: string | null
  privateKey: string
}

const ERC20_INTERFACE = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
])

type ApiResult<T = unknown> = {
  status: number
  body: T
}

function readFlag(name: string): string | null {
  const prefix = `${name}=`
  const arg = process.argv.slice(2).find((value) => value === name || value.startsWith(prefix))
  if (!arg) return null
  if (arg === name) return "true"
  return arg.slice(prefix.length).trim()
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function readEnv(name: string, fallback = ""): string {
  const cli = readFlag(`--${name.toLowerCase().replaceAll("_", "-")}`)
  if (cli && cli !== "true") return cli
  return process.env[name]?.trim() || fallback
}

function requireEnv(name: string): string {
  const value = readEnv(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function readSmokeAccessMode(): "public" | "locked" {
  const value = readEnv("PIRATE_SMOKE_ACCESS_MODE", "public").toLowerCase()
  if (value === "public" || value === "locked") return value
  throw new Error(`PIRATE_SMOKE_ACCESS_MODE must be public or locked, got ${value}`)
}

function readSmokeAuthMode(): "upstream_jwt" | "staging_test" {
  const value = readEnv("PIRATE_SMOKE_AUTH_MODE", "upstream_jwt").toLowerCase()
  if (value === "upstream_jwt" || value === "staging_test") return value
  throw new Error(`PIRATE_SMOKE_AUTH_MODE must be upstream_jwt or staging_test, got ${value}`)
}

function normalizePrivateKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
  return /^0x[a-fA-F0-9]{64}$/.test(prefixed) ? prefixed : null
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, "")
}

function decodePublicId(value: string, prefix: string): string {
  const normalized = value.trim()
  const publicPrefix = `${prefix}_`
  return normalized.startsWith(publicPrefix) ? normalized.slice(publicPrefix.length) : normalized
}

function shouldUseLocalMembershipSetup(apiBaseUrl: string): boolean {
  if (hasFlag("--no-local-membership-setup")) return false
  const explicit = readEnv("PIRATE_SMOKE_ENSURE_LOCAL_MEMBERSHIP")
  if (explicit) return ["1", "true", "yes", "on"].includes(explicit.toLowerCase())
  const hostname = new URL(apiBaseUrl).hostname
  return hostname === "127.0.0.1" || hostname === "localhost"
}

function toRequestArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toRequestArrayBuffer(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function makeSilentWavBytes(durationSeconds = 4): Uint8Array {
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

function ensureLocalMembership(input: {
  env: Record<string, string | undefined>
  communityId: string
  session: SmokeSession
}): void {
  const root = input.env.LOCAL_COMMUNITY_DB_ROOT?.trim()
  if (!root) {
    throw new Error("LOCAL_COMMUNITY_DB_ROOT is required for local membership setup")
  }
  const localDevVars = readDevVarsFromCwd()
  const communityDbRoot = localDevVars.LOCAL_COMMUNITY_DB_ROOT?.trim() || root
  const controlPlaneDb = resolveSqlitePathFromUrl(
    localDevVars.CONTROL_PLANE_DATABASE_URL ?? input.env.CONTROL_PLANE_DATABASE_URL,
    ".local/control-plane.db",
  )
  const rawUserId = decodePublicId(input.session.userId, "usr")
  const rawCommunityId = decodePublicId(input.communityId, "com")
  const now = new Date().toISOString()
  const db = new Database(join(communityDbRoot, `community-${rawCommunityId}.db`))
  try {
    db.run(
      `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4)
        ON CONFLICT(membership_id) DO UPDATE SET
          status = 'member',
          joined_at = excluded.joined_at,
          left_at = NULL,
          banned_at = NULL,
          updated_at = excluded.updated_at
      `,
      `mbr_${rawCommunityId}_${rawUserId}`,
      rawCommunityId,
      rawUserId,
      now,
    )
  } finally {
    db.close()
  }
  const controlPlane = new Database(controlPlaneDb)
  try {
    controlPlane.run(
      `
        INSERT INTO community_membership_projections (
          projection_id, community_id, user_id, membership_state, role_summary_json,
          source_updated_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'member', NULL, ?4, ?4, ?4)
        ON CONFLICT(projection_id) DO UPDATE SET
          membership_state = 'member',
          source_updated_at = excluded.source_updated_at,
          updated_at = excluded.updated_at
      `,
      `cmp_${rawCommunityId}_${rawUserId}`,
      rawCommunityId,
      rawUserId,
      now,
    )
  } finally {
    controlPlane.close()
  }
  console.log("[smoke] local membership", {
    community: rawCommunityId,
    user: rawUserId,
  })
}

function resolveSqlitePathFromUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback
  return raw.startsWith("file:") ? raw.slice("file:".length) : raw
}

function unixSeconds(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000)
}

function ensureLocalVerification(input: {
  env: Record<string, string | undefined>
  session: SmokeSession
}): void {
  const localDevVars = readDevVarsFromCwd()
  const controlPlaneDb = resolveSqlitePathFromUrl(
    localDevVars.CONTROL_PLANE_DATABASE_URL ?? input.env.CONTROL_PLANE_DATABASE_URL,
    ".local/control-plane.db",
  )
  const rawUserId = decodePublicId(input.session.userId, "usr")
  const now = new Date().toISOString()
  const verifiedAt = unixSeconds(now)
  const capabilities = {
    unique_human: {
      state: "verified",
      provider: "self",
      proof_type: "unique_human",
      mechanism: "local_smoke",
      verified_at: verifiedAt,
    },
    age_over_18: {
      state: "verified",
      provider: "self",
      proof_type: "age_over_18",
      mechanism: "local_smoke",
      verified_at: verifiedAt,
    },
    minimum_age: {
      state: "verified",
      value: 18,
      provider: "self",
      proof_type: "minimum_age",
      mechanism: "local_smoke",
      verified_at: verifiedAt,
    },
    nationality: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    gender: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    wallet_score: {
      state: "unverified",
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
      score_decimal: null,
      score_threshold_decimal: null,
      passing_score: null,
      last_scored_at: null,
      expires_at: null,
      stamps: null,
    },
  }
  const db = new Database(controlPlaneDb)
  try {
    db.run(
      `
        UPDATE users
        SET verification_state = 'verified',
            capability_provider = 'self',
            verification_capabilities_json = ?2,
            verified_at = ?3,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      rawUserId,
      JSON.stringify(capabilities),
      now,
    )
  } finally {
    db.close()
  }
  console.log("[smoke] local verification", {
    user: rawUserId,
    unique_human: "verified",
  })
}

async function readResponse<T>(response: Response): Promise<ApiResult<T>> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text.trim() ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return {
    status: response.status,
    body: body as T,
  }
}

async function api<T>(input: {
  apiBaseUrl: string
  method: string
  path: string
  token?: string | null
  body?: unknown
  bytes?: Uint8Array
  contentType?: string
  ok?: number[]
}): Promise<T> {
  const requestBody = input.body == null
    ? input.bytes == null
      ? null
      : toRequestArrayBuffer(input.bytes)
    : JSON.stringify(input.body)
  const response = await fetch(`${input.apiBaseUrl}${input.path}`, {
    method: input.method,
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body == null ? {} : { "content-type": "application/json" }),
      ...(input.bytes == null ? {} : { "content-type": input.contentType ?? "application/octet-stream" }),
    },
    body: requestBody,
  })
  const result = await readResponse<T>(response)
  const ok = input.ok ?? [200, 201, 202]
  if (!ok.includes(response.status)) {
    throw new Error(`${input.method} ${input.path} failed with ${response.status}: ${JSON.stringify(result.body)}`)
  }
  return result.body
}

async function mintUpstreamJwt(input: {
  env: Record<string, string | undefined>
  subject: string
  walletAddress: string
}): Promise<string> {
  const issuer = (input.env.AUTH_UPSTREAM_JWT_ISSUER || input.env.JWT_BASED_AUTH_ISSUERS || "pirate-dev")
    .split(",")[0]!
    .trim()
  const audience = input.env.AUTH_UPSTREAM_JWT_AUDIENCE || input.env.JWT_BASED_AUTH_AUDIENCE || "pirate-api"
  const secret = input.env.AUTH_UPSTREAM_JWT_SHARED_SECRET || input.env.JWT_BASED_AUTH_SHARED_SECRET
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET is required")

  return await new SignJWT({ wallet_address: input.walletAddress })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(secret))
}

async function mintStagingTestJwt(input: {
  subject: string
  walletAddress: string
}): Promise<string> {
  const secret = readEnv("STAGING_TEST_JWT_SHARED_SECRET")
  if (!secret) throw new Error("STAGING_TEST_JWT_SHARED_SECRET is required when PIRATE_SMOKE_AUTH_MODE=staging_test")
  return await new SignJWT({
    wallet_addresses: [input.walletAddress],
    selected_wallet_address: input.walletAddress,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(STAGING_TEST_JWT_ISSUER)
    .setAudience(STAGING_TEST_JWT_AUDIENCE)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(secret))
}

async function createSession(input: {
  apiBaseUrl: string
  env: Record<string, string | undefined>
  subject: string
  privateKey?: string | null
  walletAddress?: string | null
}): Promise<SmokeSession> {
  const normalizedPrivateKey = normalizePrivateKey(input.privateKey)
  const wallet = normalizedPrivateKey ? new Wallet(normalizedPrivateKey) : null
  const walletAddress = input.walletAddress?.trim() || wallet?.address || Wallet.createRandom().address
  const authMode = readSmokeAuthMode()
  const jwt = authMode === "staging_test"
    ? await mintStagingTestJwt({
        subject: input.subject,
        walletAddress,
      })
    : await mintUpstreamJwt({
        env: input.env,
        subject: input.subject,
        walletAddress,
      })
  const body = await api<{
    access_token: string
    user: { id: string; primary_wallet_attachment?: string | null }
    wallet_attachments?: Array<{ wallet_attachment: string; is_primary?: boolean | null }>
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: "/auth/session/exchange",
    body: {
      proof: {
        type: authMode === "staging_test" ? "staging_test_jwt" : "jwt_based_auth",
        jwt,
      },
    },
  })
  return {
    accessToken: body.access_token,
    userId: body.user.id,
    walletAddress,
    privateKey: wallet?.privateKey ?? "",
    walletAttachment:
      body.user.primary_wallet_attachment
      ?? body.wallet_attachments?.find((attachment) => attachment.is_primary)?.wallet_attachment
      ?? body.wallet_attachments?.[0]?.wallet_attachment
      ?? null,
  }
}

async function completeUniqueHuman(input: {
  apiBaseUrl: string
  session: SmokeSession
}): Promise<void> {
  const created = await api<{ id: string; status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: "/verification-sessions",
    token: input.session.accessToken,
    body: {
      provider: "self",
      requested_capabilities: ["unique_human", "age_over_18"],
    },
  })
  const completed = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/verification-sessions/${encodeURIComponent(created.id)}/complete`,
    token: input.session.accessToken,
    body: {},
    ok: [200],
  })
  console.log("[smoke] verification", {
    started: created.status,
    completed: completed.status,
  })
}

async function waitForJob(input: {
  apiBaseUrl: string
  jobId: string
  token: string
}): Promise<void> {
  const timeoutMs = Number(readEnv("PIRATE_SMOKE_JOB_TIMEOUT_MS", "180000"))
  const intervalMs = Number(readEnv("PIRATE_SMOKE_JOB_INTERVAL_MS", "3000"))
  const startedAt = Date.now()
  let lastStatus = "unknown"
  while (Date.now() - startedAt <= timeoutMs) {
    const job = await api<{ id: string; status: string; error_code?: string | null }>({
      apiBaseUrl: input.apiBaseUrl,
      method: "GET",
      path: `/jobs/${encodeURIComponent(input.jobId)}`,
      token: input.token,
    })
    lastStatus = job.status
    if (job.status === "succeeded") return
    if (job.status === "failed") {
      throw new Error(`job ${job.id} failed: ${job.error_code ?? "unknown"}`)
    }
    await sleep(intervalMs)
  }

  throw new Error(`job ${input.jobId} did not finish within ${timeoutMs}ms; last status ${lastStatus}`)
}

async function createDisposableCommunity(input: {
  apiBaseUrl: string
  owner: SmokeSession
  runId: string
}): Promise<string> {
  const created = await api<{
    community: { id: string; provisioning_state?: string | null }
    job: { id: string; status: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      display_name: `Story Royalty Allocation Smoke ${input.runId}`,
      handle_policy: {
        policy_template: "standard",
      },
      membership_mode: "request",
    },
    method: "POST",
    path: "/communities",
    token: input.owner.accessToken,
  })

  if (created.job.status !== "succeeded") {
    await waitForJob({
      apiBaseUrl: input.apiBaseUrl,
      jobId: created.job.id,
      token: input.owner.accessToken,
    })
  }

  console.log("[smoke] community", {
    community: created.community.id,
    job: created.job.id,
    provisioning_state: created.community.provisioning_state ?? null,
  })
  return created.community.id
}

async function approveCommunityMembership(input: {
  apiBaseUrl: string
  applicant: SmokeSession
  communityId: string
  owner: SmokeSession
}): Promise<void> {
  const join = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      note: "Story royalty allocation smoke participant",
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/join`,
    token: input.applicant.accessToken,
  })
  if (join.status === "joined") {
    console.log("[smoke] participant membership", {
      status: "joined",
      user: input.applicant.userId,
    })
    return
  }
  if (join.status !== "requested") {
    throw new Error(`membership join returned unexpected status ${join.status}`)
  }

  const requests = await api<{
    items: Array<{ applicant_user: string; id: string; status: string }>
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/membership-requests?limit=25`,
    token: input.owner.accessToken,
  })
  const request = requests.items.find((item) => item.applicant_user === input.applicant.userId && item.status === "pending")
    ?? requests.items.find((item) => item.status === "pending")
  if (!request) {
    throw new Error(`pending membership request not found: ${JSON.stringify(requests.items)}`)
  }

  const approved = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/membership-requests/${encodeURIComponent(request.id)}/approve`,
    token: input.owner.accessToken,
  })
  if (approved.status !== "approved") {
    throw new Error(`membership approval returned ${approved.status}`)
  }
  console.log("[smoke] participant membership", {
    request: request.id,
    status: approved.status,
    user: input.applicant.userId,
  })
}

async function uploadSong(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  title: string
  filename: string
  bytes: Uint8Array
}): Promise<string> {
  const upload = await uploadSongArtifact({
    apiBaseUrl: input.apiBaseUrl,
    communityId: input.communityId,
    session: input.session,
    artifactKind: "primary_audio",
    mimeType: "audio/wav",
    filename: input.filename,
    bytes: input.bytes,
  })
  const bundle = await api<{ id: string; status?: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifacts`,
    token: input.session.accessToken,
    body: {
      primary_audio: {
        song_artifact_upload: upload.id,
      },
      preview_window: {
        start_ms: 0,
        duration_ms: 30_000,
      },
      title: input.title,
      lyrics: "Story remix smoke lyric",
    },
  })
  console.log("[smoke] bundle", {
    title: input.title,
    bundle: bundle.id,
    status: bundle.status ?? null,
  })
  return bundle.id
}

type SmokeSongArtifactBundle = {
  id: string
  preview_audio?: { mime_type?: string | null; storage_ref?: string | null } | null
  preview_error?: string | null
  preview_status?: string | null
  status?: string | null
}

async function readSongBundle(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  bundle: string
}): Promise<SmokeSongArtifactBundle> {
  return await api<SmokeSongArtifactBundle>({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifacts/${encodeURIComponent(input.bundle)}`,
    token: input.session.accessToken,
  })
}

async function waitForSongPreviewReady(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  bundle: string
  title: string
}): Promise<SmokeSongArtifactBundle> {
  const timeoutMs = Number(readEnv("PIRATE_SMOKE_PREVIEW_TIMEOUT_MS", "180000"))
  const intervalMs = Number(readEnv("PIRATE_SMOKE_PREVIEW_INTERVAL_MS", "5000"))
  const startedAt = Date.now()
  let lastBundle: SmokeSongArtifactBundle | null = null

  while (Date.now() - startedAt <= timeoutMs) {
    const bundle = await readSongBundle(input)
    lastBundle = bundle
    console.log("[smoke] song preview", {
      title: input.title,
      bundle: input.bundle,
      status: bundle.status ?? null,
      preview_status: bundle.preview_status ?? null,
      has_preview_audio: Boolean(bundle.preview_audio?.storage_ref),
      elapsed_ms: Date.now() - startedAt,
    })
    if (bundle.preview_status === "completed" && bundle.preview_audio?.storage_ref && bundle.preview_audio.mime_type) {
      return bundle
    }
    if (bundle.preview_status === "failed") {
      throw new Error(`song preview generation failed: ${JSON.stringify(bundle)}`)
    }
    await sleep(intervalMs)
  }

  throw new Error(`song preview did not become ready within ${timeoutMs}ms: ${JSON.stringify(lastBundle)}`)
}

async function uploadSongArtifact(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  artifactKind: "primary_audio" | "primary_video" | "preview_video"
  mimeType: string
  filename: string
  bytes: Uint8Array
}): Promise<{ id: string; storage_ref: string }> {
  if (input.artifactKind === "primary_audio") {
    const contentHash = `0x${await sha256Hex(input.bytes)}`
    const upload = await api<{
      id: string
      storage_ref?: string | null
      upload_session?: {
        id?: string | null
        upload_id?: string | null
        total_parts?: number | null
      } | null
    }>({
      apiBaseUrl: input.apiBaseUrl,
      method: "POST",
      path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads`,
      token: input.session.accessToken,
      body: {
        upload_mode: "direct_multipart",
        artifact_kind: input.artifactKind,
        mime_type: input.mimeType,
        filename: input.filename,
        size_bytes: input.bytes.byteLength,
        content_hash: contentHash,
      },
    })
    const sessionId = upload.upload_session?.id?.trim()
    const uploadId = upload.upload_session?.upload_id?.trim()
    const totalParts = Number(upload.upload_session?.total_parts)
    if (!sessionId || !uploadId || totalParts !== 1) {
      throw new Error(`unexpected direct multipart upload session: ${JSON.stringify(upload.upload_session)}`)
    }
    const signed = await api<{ url?: string | null }>({
      apiBaseUrl: input.apiBaseUrl,
      method: "GET",
      path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(upload.id)}/sessions/${encodeURIComponent(sessionId)}/parts/1/signed-url`,
      token: input.session.accessToken,
    })
    const signedUrl = signed.url?.trim()
    if (!signedUrl) throw new Error("direct multipart signed URL missing")
    const put = await fetch(signedUrl, {
      method: "PUT",
      headers: { "content-type": input.mimeType },
      body: input.bytes,
    })
    const etag = put.headers.get("etag")
    if (!put.ok || !etag) {
      throw new Error(`direct multipart part PUT failed: ${put.status}; etag=${etag}; body=${(await put.text()).slice(0, 800)}`)
    }
    const completed = await api<{ storage_ref?: string | null }>({
      apiBaseUrl: input.apiBaseUrl,
      method: "POST",
      path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(upload.id)}/sessions/${encodeURIComponent(sessionId)}/complete`,
      token: input.session.accessToken,
      body: {
        upload_id: uploadId,
        parts: [{ part_number: 1, etag }],
        content_hash: contentHash,
      },
    })
    return {
      id: upload.id,
      storage_ref: completed.storage_ref ?? upload.storage_ref ?? "",
    }
  }

  const upload = await api<{ id: string; storage_ref: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads`,
    token: input.session.accessToken,
    body: {
      artifact_kind: input.artifactKind,
      mime_type: input.mimeType,
      filename: input.filename,
      size_bytes: input.bytes.byteLength,
    },
  })
  await api({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(upload.id)}/content`,
    token: input.session.accessToken,
    bytes: input.bytes,
    contentType: "application/octet-stream",
  })
  return upload
}

async function readAsset(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  asset: string
}): Promise<{
  access_mode?: string | null
  locked_delivery_status?: string | null
  locked_delivery_error?: string | null
  story_error?: string | null
  story_cdr_vault_uuid?: number | null
  story_ip?: string | null
  story_license_terms?: string | null
  story_royalty_registration_status?: string | null
  story_status?: string | null
  story_derivative_parent_ip_ids?: string[] | null
  publication_status?: string | null
}> {
  return await api({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/assets/${encodeURIComponent(input.asset)}`,
    token: input.session.accessToken,
  })
}

async function waitForAssetReady(input: {
  accessMode: "public" | "locked"
  apiBaseUrl: string
  asset: string
  communityId: string
  label: string
  session: SmokeSession
}): ReturnType<typeof readAsset> {
  const timeoutMs = Number(readEnv("PIRATE_SMOKE_ASSET_READY_TIMEOUT_MS", "420000"))
  const intervalMs = Number(readEnv("PIRATE_SMOKE_ASSET_READY_INTERVAL_MS", "5000"))
  const startedAt = Date.now()
  let lastAsset: Awaited<ReturnType<typeof readAsset>> | null = null

  while (Date.now() - startedAt <= timeoutMs) {
    const asset = await readAsset(input)
    lastAsset = asset
    console.log("[smoke] asset status", {
      label: input.label,
      asset: input.asset,
      access_mode: asset.access_mode ?? null,
      locked_delivery_status: asset.locked_delivery_status ?? null,
      story_status: asset.story_status ?? null,
      story_royalty_registration_status: asset.story_royalty_registration_status ?? null,
      story_ip: asset.story_ip ?? null,
      elapsed_ms: Date.now() - startedAt,
    })

    if (asset.locked_delivery_status === "failed" || asset.locked_delivery_error) {
      throw new Error(`${input.label} locked delivery failed: ${JSON.stringify(asset)}`)
    }
    if (asset.story_royalty_registration_status === "failed" || asset.story_error) {
      throw new Error(`${input.label} Story registration failed: ${JSON.stringify(asset)}`)
    }
    const lockedReady = input.accessMode !== "locked" || asset.locked_delivery_status === "ready"
    const storyReady = asset.story_royalty_registration_status === "registered" && Boolean(asset.story_ip)
    if (lockedReady && storyReady) {
      return asset
    }
    await sleep(intervalMs)
  }

  throw new Error(`${input.label} did not become ready within ${timeoutMs}ms: ${JSON.stringify(lastAsset)}`)
}

async function createSongPost(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  title: string
  bundle: string
  songMode: "original" | "remix"
  accessMode: "public" | "locked"
  rightsBasis: "original" | "derivative"
  upstreamAssetRefs?: string[] | null
  royaltyAllocations?: Array<{ recipient_kind: "creator" | "collaborator"; wallet_address: string; share_bps: number }> | null
}): Promise<{ post: string; asset: string }> {
  const body = await api<{ id: string; asset?: string | null }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/posts`,
    token: input.session.accessToken,
    body: {
      idempotency_key: `story-remix-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      post_type: "song",
      identity_mode: "public",
      title: input.title,
      access_mode: input.accessMode,
      song_mode: input.songMode,
      rights_basis: input.rightsBasis,
      license_preset: "commercial-remix",
      commercial_rev_share_pct: 10,
      upstream_asset_refs: input.upstreamAssetRefs ?? undefined,
      royalty_allocations: input.royaltyAllocations ?? undefined,
      song_artifact_bundle: input.bundle,
    },
  })
  if (!body.asset) throw new Error(`post ${body.id} did not return an asset id`)
  return {
    post: body.id,
    asset: body.asset,
  }
}

async function createVideoPost(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  title: string
  videoStorageRef: string
  videoSizeBytes: number
  accessMode: "public" | "locked"
  upstreamAssetRefs: string[]
}): Promise<{ post: string; asset: string }> {
  const body = await api<{ id: string; asset?: string | null }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/posts`,
    token: input.session.accessToken,
    body: {
      idempotency_key: `story-video-derivative-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      post_type: "video",
      identity_mode: "public",
      title: input.title,
      visibility: "members_only",
      access_mode: input.accessMode,
      license_preset: "non-commercial",
      rights_basis: "derivative",
      upstream_asset_refs: input.upstreamAssetRefs,
      media_refs: [{
        storage_ref: input.videoStorageRef,
        mime_type: "video/mp4",
        size_bytes: input.videoSizeBytes,
        poster_ref: readEnv("PIRATE_SMOKE_VIDEO_POSTER_REF", "ipfs://story-video-derivative-smoke-poster"),
        poster_mime_type: "image/jpeg",
        poster_size_bytes: 1024,
        poster_width: 1280,
        poster_height: 720,
        poster_frame_ms: 0,
      }],
    },
  })
  if (!body.asset) throw new Error(`video post ${body.id} did not return an asset id`)
  return {
    post: body.id,
    asset: body.asset,
  }
}

function resolveCheckoutSourceChainId(env: Record<string, string | undefined>): number {
  const parsed = Number(env.PIRATE_CHECKOUT_SOURCE_CHAIN_ID || "84532")
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 84532
}

function resolveCheckoutChainName(chainId: number): string {
  if (chainId === 8453) return "Base"
  if (chainId === 84532) return "Base Sepolia"
  return `Chain ${chainId}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveCheckoutOperatorAddress(env: Record<string, string | undefined>): string {
  const explicit = env.PIRATE_CHECKOUT_OPERATOR_ADDRESS?.trim()
  if (explicit) return getAddress(explicit)
  const operatorPrivateKey = normalizePrivateKey(env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY)
  if (!operatorPrivateKey) throw new Error("PIRATE_CHECKOUT_OPERATOR_ADDRESS or PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY is required")
  return getAddress(new Wallet(operatorPrivateKey).address)
}

async function sendCheckoutFunding(input: {
  env: Record<string, string | undefined>
  buyer: SmokeSession
  quote: {
    final_price_cents: number
    funding_destination_address?: string | null
  }
}): Promise<string> {
  const rpcUrl = input.env.PIRATE_CHECKOUT_RPC_URL?.trim()
  const usdc = input.env.PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS?.trim()
  if (!rpcUrl) throw new Error("PIRATE_CHECKOUT_RPC_URL is required")
  if (!usdc) throw new Error("PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS is required")
  if (!Number.isSafeInteger(input.quote.final_price_cents) || input.quote.final_price_cents <= 0) {
    throw new Error("quote final_price_cents is invalid")
  }

  const destination = getAddress(input.quote.funding_destination_address || resolveCheckoutOperatorAddress(input.env))
  const amountAtomic = BigInt(input.quote.final_price_cents) * 10_000n
  const provider = new JsonRpcProvider(rpcUrl, resolveCheckoutSourceChainId(input.env))
  const wallet = new Wallet(input.buyer.privateKey, provider)
  const tx = await wallet.sendTransaction({
    to: getAddress(usdc),
    data: ERC20_INTERFACE.encodeFunctionData("transfer", [destination, amountAtomic]),
  })
  console.log("[smoke] checkout funding", {
    tx: tx.hash,
    from: wallet.address,
    to: destination,
    amount_usdc_atomic: amountAtomic.toString(),
  })
  const receipt = await tx.wait(1)
  if (!receipt || receipt.status !== 1) {
    throw new Error(`checkout funding transaction failed: ${tx.hash}`)
  }
  return tx.hash
}

async function settleListingPurchase(input: {
  apiBaseUrl: string
  env: Record<string, string | undefined>
  communityId: string
  listing: string
  buyer: SmokeSession
}): Promise<void> {
  if (!input.buyer.walletAttachment) {
    throw new Error("buyer wallet attachment is required for purchase settlement")
  }
  const chainId = resolveCheckoutSourceChainId(input.env)
  const quote = await api<{
    id: string
    final_price_cents: number
    settlement_mode: string
    destination_settlement_amount_atomic?: string | null
    funding_destination_address?: string | null
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/purchase-quotes`,
    token: input.buyer.accessToken,
    body: {
      listing: input.listing,
      client_estimated_hop_count: 1,
      client_estimated_slippage_bps: 0,
      funding_asset: {
        asset_symbol: "USDC",
        chain_namespace: "eip155",
        chain_id: chainId,
        display_name: `USDC on ${resolveCheckoutChainName(chainId)}`,
      },
      route_provider: "pirate_checkout",
      source_chain: {
        chain_namespace: "eip155",
        chain_id: chainId,
        display_name: resolveCheckoutChainName(chainId),
      },
    },
  })
  console.log("[smoke] purchase quote", {
    quote: quote.id,
    final_price_cents: quote.final_price_cents,
    settlement_mode: quote.settlement_mode,
    destination_settlement_amount_atomic: quote.destination_settlement_amount_atomic ?? null,
  })
  if (quote.settlement_mode !== "royalty_native_story_payment") {
    throw new Error(`purchase quote did not use Story royalty settlement: ${JSON.stringify(quote)}`)
  }
  const fundingTx = await sendCheckoutFunding({
    env: input.env,
    buyer: input.buyer,
    quote,
  })
  const settlement = await api<{
    id: string
    asset?: string | null
    settlement_mode: string
    settlement_tx_ref: string
    allocations?: Array<{ settlement_strategy: string; amount_cents?: number | null; amount_usd?: number | null; share_bps?: number | null }>
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/purchase-settlements`,
    token: input.buyer.accessToken,
    body: {
      quote: quote.id,
      settlement_wallet_attachment: input.buyer.walletAttachment,
      funding_tx_ref: fundingTx,
      settlement_tx_ref: fundingTx,
    },
  })
  console.log("[smoke] purchase settlement", {
    settlement: settlement.id,
    asset: settlement.asset ?? null,
    settlement_mode: settlement.settlement_mode,
    settlement_tx_ref: settlement.settlement_tx_ref,
    allocations: settlement.allocations ?? [],
  })
  if (settlement.settlement_mode !== "royalty_native_story_payment") {
    throw new Error(`purchase settlement did not use Story royalty settlement: ${JSON.stringify(settlement)}`)
  }
  if (!settlement.settlement_tx_ref) {
    throw new Error(`purchase settlement is missing settlement_tx_ref: ${JSON.stringify(settlement)}`)
  }
}

async function pollOriginalClaimable(input: {
  apiBaseUrl: string
  author: SmokeSession
  originalAsset: string
  originalStoryIp: string
}): Promise<void> {
  const timeoutMs = Number(readEnv("PIRATE_SMOKE_CLAIMABLE_TIMEOUT_MS", "180000"))
  const intervalMs = Number(readEnv("PIRATE_SMOKE_CLAIMABLE_INTERVAL_MS", "5000"))
  const startedAt = Date.now()
  let lastItems: unknown[] = []

  while (Date.now() - startedAt <= timeoutMs) {
    const claimable = await api<{
      total_claimable_wip_wei: string
      items: Array<{ asset?: string | null; ip?: string | null; claimable_wip_wei: string; title?: string | null }>
    }>({
      apiBaseUrl: input.apiBaseUrl,
      method: "GET",
      path: "/royalties/claimable",
      token: input.author.accessToken,
    })
    lastItems = claimable.items
    const match = claimable.items.find((item) => {
      return item.asset === input.originalAsset || item.ip?.toLowerCase() === input.originalStoryIp.toLowerCase()
    })
    if (match && BigInt(match.claimable_wip_wei) > 0n) {
      console.log("[smoke] original claimable royalty", {
        asset: match.asset ?? null,
        ip: match.ip ?? null,
        claimable_wip_wei: match.claimable_wip_wei,
        title: match.title ?? null,
      })
      return
    }
    await sleep(intervalMs)
  }

  throw new Error(`original royalty did not become claimable within ${timeoutMs}ms: ${JSON.stringify(lastItems)}`)
}

async function main(): Promise<void> {
  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Record<string, string | undefined>
  const apiBaseUrl = normalizeApiBaseUrl(readEnv("PIRATE_SMOKE_API_BASE_URL", "http://127.0.0.1:8787"))
  let communityId = readEnv("PIRATE_SMOKE_COMMUNITY_ID").replace(/^com_/, "")
  const shouldCreateCommunity = hasFlag("--create-community") || !communityId
  const accessMode = readSmokeAccessMode()
  const titlePrefix = readEnv("PIRATE_SMOKE_TITLE_PREFIX", "Palestine, Don't Cry")
  const skipVerification = hasFlag("--skip-verification")
  const useLocalSetup = shouldUseLocalMembershipSetup(apiBaseUrl)
  const settlePurchase = hasFlag("--settle-purchase")
  const createDerivativeVideo = hasFlag("--create-derivative-video")
  const createRoyaltyAllocation = hasFlag("--royalty-allocation")
  const createDerivativeRoyaltyAllocation = hasFlag("--derivative-royalty-allocation")
  const useExistingSource = hasFlag("--use-existing-source")
  if (createDerivativeVideo && accessMode !== "locked") {
    throw new Error("--create-derivative-video requires PIRATE_SMOKE_ACCESS_MODE=locked")
  }
  if (createRoyaltyAllocation && accessMode !== "locked") {
    throw new Error("--royalty-allocation requires PIRATE_SMOKE_ACCESS_MODE=locked")
  }
  if (createDerivativeRoyaltyAllocation && accessMode !== "locked") {
    throw new Error("--derivative-royalty-allocation requires PIRATE_SMOKE_ACCESS_MODE=locked")
  }
  const runId = Date.now()
  const authorSubject = readEnv("PIRATE_SMOKE_AUTHOR_SUBJECT", `story-remix-smoke-author-${runId}`)
  const collaboratorSubject = readEnv("PIRATE_SMOKE_COLLABORATOR_SUBJECT", `story-remix-smoke-collaborator-${runId}`)
  const remixerSubject = readEnv("PIRATE_SMOKE_REMIXER_SUBJECT", `story-remix-smoke-remixer-${runId}`)
  const buyerSubject = readEnv("PIRATE_SMOKE_BUYER_SUBJECT", `story-remix-smoke-buyer-${runId}`)
  console.log("[smoke] config", {
    apiBaseUrl,
    communityId: communityId || null,
    shouldCreateCommunity,
    access_mode: accessMode,
    skipVerification,
    auth_mode: readSmokeAuthMode(),
    useLocalSetup,
    settlePurchase,
    createDerivativeVideo,
    createRoyaltyAllocation,
    createDerivativeRoyaltyAllocation,
    useExistingSource,
    author_subject: authorSubject,
    collaborator_subject: createRoyaltyAllocation || createDerivativeRoyaltyAllocation ? collaboratorSubject : null,
    remixer_subject: remixerSubject,
  })

  const author = await createSession({
    apiBaseUrl,
    env,
    subject: authorSubject,
    walletAddress: readEnv("PIRATE_SMOKE_AUTHOR_WALLET"),
  })
  console.log("[smoke] author", {
    user: author.userId,
    wallet: author.walletAddress,
    wallet_attachment: author.walletAttachment,
  })
  if (useLocalSetup) {
    ensureLocalMembership({
      env,
      communityId,
      session: author,
    })
    ensureLocalVerification({
      env,
      session: author,
    })
  }
  if (!skipVerification && !useLocalSetup) {
    await completeUniqueHuman({ apiBaseUrl, session: author })
  }
  if (shouldCreateCommunity) {
    communityId = await createDisposableCommunity({
      apiBaseUrl,
      owner: author,
      runId: String(runId),
    })
  }
  const collaborator = createRoyaltyAllocation || createDerivativeRoyaltyAllocation
    ? await createSession({
      apiBaseUrl,
      env,
      subject: collaboratorSubject,
      walletAddress: readEnv("PIRATE_SMOKE_COLLABORATOR_WALLET"),
    })
    : null
  if (collaborator) {
    console.log("[smoke] collaborator", {
      user: collaborator.userId,
      wallet: collaborator.walletAddress,
      wallet_attachment: collaborator.walletAttachment,
    })
    if (useLocalSetup) {
      ensureLocalMembership({
        env,
        communityId,
        session: collaborator,
      })
      ensureLocalVerification({
        env,
        session: collaborator,
      })
    } else if (!skipVerification) {
      await completeUniqueHuman({ apiBaseUrl, session: collaborator })
    }
    if (shouldCreateCommunity) {
      await approveCommunityMembership({
        apiBaseUrl,
        applicant: collaborator,
        communityId,
        owner: author,
      })
    }
  }

  let originalPost: { post: string | null; asset: string }
  let originalAsset: {
    story_ip?: string | null
    story_license_terms?: string | null
    story_royalty_registration_status?: string | null
    locked_delivery_status?: string | null
    story_cdr_vault_uuid?: number | null
  }
  let source: { asset: string; title: string; source_ref?: string | null; story_ip: string; story_license_terms: string }
  if (useExistingSource) {
    const sourceAsset = readEnv("PIRATE_SMOKE_SOURCE_ASSET").replace(/^asset_/, "")
    const sourceQuery = readEnv("PIRATE_SMOKE_SOURCE_QUERY", titlePrefix)
    const catalog = await api<{
      items: Array<{ asset: string; title: string; source_ref?: string | null; story_ip: string; story_license_terms: string }>
    }>({
      apiBaseUrl,
      method: "GET",
      path: `/communities/${encodeURIComponent(communityId)}/derivative-sources?scope=global&kind=song&limit=25&q=${encodeURIComponent(sourceQuery)}`,
      token: author.accessToken,
    })
    console.log("[smoke] existing derivative sources", {
      query: sourceQuery,
      count: catalog.items.length,
      requested_asset: sourceAsset || null,
      first: catalog.items[0] ?? null,
    })
    source = (sourceAsset
      ? catalog.items.find((item) => item.asset.replace(/^asset_/, "") === sourceAsset)
      : catalog.items[0]) as typeof source
    if (!source) throw new Error(`existing source not found in derivative sources: asset=${sourceAsset || "<first>"} query=${sourceQuery}`)
    originalPost = { post: null, asset: source.asset }
    originalAsset = {
      story_ip: source.story_ip,
      story_license_terms: source.story_license_terms,
      story_royalty_registration_status: "registered",
      locked_delivery_status: null,
      story_cdr_vault_uuid: null,
    }
    console.log("[smoke] existing source asset", {
      asset: source.asset,
      title: source.title,
      story_ip: source.story_ip,
      story_license_terms: source.story_license_terms,
      source_ref: source.source_ref ?? null,
    })
  } else {
    const originalTitle = `${titlePrefix} Smoke Original ${new Date().toISOString()}`
    const originalBundle = await uploadSong({
      apiBaseUrl,
      communityId,
      session: author,
      title: originalTitle,
      filename: "story-smoke-original.wav",
      bytes: makeSilentWavBytes(),
    })
    if (accessMode === "locked") {
      await waitForSongPreviewReady({
        apiBaseUrl,
        communityId,
        session: author,
        bundle: originalBundle,
        title: originalTitle,
      })
    }
    originalPost = await createSongPost({
      apiBaseUrl,
      communityId,
      session: author,
      title: originalTitle,
      bundle: originalBundle,
      songMode: "original",
      accessMode,
      rightsBasis: "original",
      royaltyAllocations: collaborator
        ? [
          { recipient_kind: "creator", wallet_address: author.walletAddress, share_bps: 9000 },
          { recipient_kind: "collaborator", wallet_address: collaborator.walletAddress, share_bps: 1000 },
        ]
        : null,
    })
    originalAsset = await waitForAssetReady({
      accessMode,
      apiBaseUrl,
      asset: originalPost.asset,
      communityId,
      label: "original",
      session: author,
    })
    console.log("[smoke] original asset", {
      post: originalPost.post,
      asset: originalPost.asset,
      access_mode: originalAsset.access_mode ?? null,
      locked_delivery_status: originalAsset.locked_delivery_status ?? null,
      story_cdr_vault_uuid: originalAsset.story_cdr_vault_uuid ?? null,
      story_ip: originalAsset.story_ip ?? null,
      story_license_terms: originalAsset.story_license_terms ?? null,
      story_royalty_registration_status: originalAsset.story_royalty_registration_status ?? null,
      royalty_allocation_requested: Boolean(collaborator),
      royalty_allocation_wallets: collaborator
        ? [
          { recipient_kind: "creator", wallet: author.walletAddress, share_bps: 9000 },
          { recipient_kind: "collaborator", wallet: collaborator.walletAddress, share_bps: 1000 },
        ]
        : null,
    })
    if (accessMode === "locked" && originalAsset.locked_delivery_status !== "ready") {
      throw new Error(`original locked delivery was not ready: ${JSON.stringify(originalAsset)}`)
    }
    if (originalAsset.story_royalty_registration_status !== "registered") {
      throw new Error(`original asset was not Story registered: ${JSON.stringify(originalAsset)}`)
    }
    if (collaborator) {
      console.log("[smoke] royalty allocation verifier target", {
        community: communityId,
        asset: originalPost.asset,
        expected_status_after_cron: "verified",
        expected_distribution_status_after_cron: "verified",
        note: "Poll the community shard for assets.royalty_allocation_status and initial_royalty_allocations.distribution_status.",
      })
    }

    const catalog = await api<{
    items: Array<{ asset: string; title: string; source_ref?: string | null; story_ip: string; story_license_terms: string }>
    }>({
      apiBaseUrl,
      method: "GET",
      path: `/communities/${encodeURIComponent(communityId)}/derivative-sources?kind=song&q=${encodeURIComponent(originalTitle)}`,
      token: author.accessToken,
    })
    console.log("[smoke] derivative sources", {
      count: catalog.items.length,
      first: catalog.items[0] ?? null,
    })
    source = catalog.items.find((item) => item.asset === originalPost.asset) ?? catalog.items[0]
    if (!source) throw new Error("original did not appear in derivative sources")
  }
  const upstreamAssetRefs = [source.source_ref?.trim() || `story:asset:${source.asset}`]

  const remixer = await createSession({
    apiBaseUrl,
    env,
    subject: remixerSubject,
    walletAddress: readEnv("PIRATE_SMOKE_REMIXER_WALLET"),
  })
  console.log("[smoke] remixer", {
    user: remixer.userId,
    wallet: remixer.walletAddress,
    wallet_attachment: remixer.walletAttachment,
  })
  if (useLocalSetup) {
    ensureLocalMembership({
      env,
      communityId,
      session: remixer,
    })
    ensureLocalVerification({
      env,
      session: remixer,
    })
  } else if (!skipVerification) {
    await completeUniqueHuman({ apiBaseUrl, session: remixer })
  }
  if (shouldCreateCommunity) {
    await approveCommunityMembership({
      apiBaseUrl,
      applicant: remixer,
      communityId,
      owner: author,
    })
  }

  const remixTitle = `${titlePrefix} Smoke Remix ${new Date().toISOString()}`
  const remixBundle = await uploadSong({
    apiBaseUrl,
    communityId,
    session: remixer,
    title: remixTitle,
    filename: "story-smoke-remix.wav",
    bytes: makeSilentWavBytes(),
  })
  if (accessMode === "locked") {
    await waitForSongPreviewReady({
      apiBaseUrl,
      communityId,
      session: remixer,
      bundle: remixBundle,
      title: remixTitle,
    })
  }
  const remixPost = await createSongPost({
    apiBaseUrl,
    communityId,
    session: remixer,
    title: remixTitle,
    bundle: remixBundle,
    songMode: "remix",
    accessMode,
    rightsBasis: "derivative",
    upstreamAssetRefs,
    royaltyAllocations: createDerivativeRoyaltyAllocation && collaborator
      ? [
        { recipient_kind: "creator", wallet_address: remixer.walletAddress, share_bps: 6667 },
        { recipient_kind: "collaborator", wallet_address: collaborator.walletAddress, share_bps: 3333 },
      ]
      : null,
  })
  const remixAsset = await waitForAssetReady({
    accessMode,
    apiBaseUrl,
    asset: remixPost.asset,
    communityId,
    label: "remix",
    session: author,
  })
  console.log("[smoke] remix asset", {
    post: remixPost.post,
    asset: remixPost.asset,
    access_mode: remixAsset.access_mode ?? null,
    locked_delivery_status: remixAsset.locked_delivery_status ?? null,
    story_cdr_vault_uuid: remixAsset.story_cdr_vault_uuid ?? null,
    story_ip: remixAsset.story_ip ?? null,
    story_royalty_registration_status: remixAsset.story_royalty_registration_status ?? null,
    parents: remixAsset.story_derivative_parent_ip_ids ?? null,
    royalty_allocation_requested: createDerivativeRoyaltyAllocation,
    royalty_allocation_wallets: createDerivativeRoyaltyAllocation && collaborator
      ? [
        { recipient_kind: "creator", wallet: remixer.walletAddress, share_bps: 6667 },
        { recipient_kind: "collaborator", wallet: collaborator.walletAddress, share_bps: 3333 },
      ]
      : null,
  })
  if (accessMode === "locked" && remixAsset.locked_delivery_status !== "ready") {
    throw new Error(`remix locked delivery was not ready: ${JSON.stringify(remixAsset)}`)
  }
  if (remixAsset.story_royalty_registration_status !== "registered") {
    throw new Error(`remix asset was not Story registered: ${JSON.stringify(remixAsset)}`)
  }
  const parentIps = remixAsset.story_derivative_parent_ip_ids ?? []
  if (!parentIps.some((parentIp) => parentIp.toLowerCase() === originalAsset.story_ip?.toLowerCase())) {
    throw new Error(`remix asset missing original parent IP: ${JSON.stringify(remixAsset)}`)
  }

  if (createDerivativeVideo) {
    const videoTitle = `${titlePrefix} Smoke Video Uses Song ${new Date().toISOString()}`
    const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0])
    const videoUpload = await uploadSongArtifact({
      apiBaseUrl,
      communityId,
      session: remixer,
      artifactKind: "primary_video",
      mimeType: "video/mp4",
      filename: "story-smoke-video-uses-song.mp4",
      bytes: videoBytes,
    })
    const videoPost = await createVideoPost({
      apiBaseUrl,
      communityId,
      session: remixer,
      title: videoTitle,
      videoStorageRef: videoUpload.storage_ref,
      videoSizeBytes: videoBytes.byteLength,
      accessMode,
      upstreamAssetRefs,
    })
    const videoAsset = await waitForAssetReady({
      accessMode,
      apiBaseUrl,
      asset: videoPost.asset,
      communityId,
      label: "derivative video",
      session: author,
    })
    console.log("[smoke] derivative video asset", {
      post: videoPost.post,
      asset: videoPost.asset,
      access_mode: videoAsset.access_mode ?? null,
      locked_delivery_status: videoAsset.locked_delivery_status ?? null,
      story_cdr_vault_uuid: videoAsset.story_cdr_vault_uuid ?? null,
      story_ip: videoAsset.story_ip ?? null,
      story_royalty_registration_status: videoAsset.story_royalty_registration_status ?? null,
      parents: videoAsset.story_derivative_parent_ip_ids ?? null,
      upstream_asset_refs: upstreamAssetRefs,
    })
    if (accessMode === "locked" && videoAsset.locked_delivery_status !== "ready") {
      throw new Error(`derivative video locked delivery was not ready: ${JSON.stringify(videoAsset)}`)
    }
    if (videoAsset.story_royalty_registration_status !== "registered") {
      throw new Error(`derivative video asset was not Story registered: ${JSON.stringify(videoAsset)}`)
    }
    const videoParentIps = videoAsset.story_derivative_parent_ip_ids ?? []
    if (!videoParentIps.some((parentIp) => parentIp.toLowerCase() === originalAsset.story_ip?.toLowerCase())) {
      throw new Error(`derivative video asset missing original parent IP: ${JSON.stringify(videoAsset)}`)
    }
  }

  if (hasFlag("--create-listing") || settlePurchase) {
    const listing = await api<{ id: string; status: string }>({
      apiBaseUrl,
      method: "POST",
      path: `/communities/${encodeURIComponent(communityId)}/listings`,
      token: remixer.accessToken,
      body: {
        asset: remixPost.asset,
        price_cents: Number(readEnv("PIRATE_SMOKE_PRICE_CENTS", "399")),
        regional_pricing_enabled: false,
        status: "active",
      },
    })
    console.log("[smoke] listing", listing)
    if (settlePurchase) {
      const buyer = await createSession({
        apiBaseUrl,
        env,
        subject: buyerSubject,
        privateKey: requireEnv("PIRATE_SMOKE_BUYER_PRIVATE_KEY"),
      })
      console.log("[smoke] buyer", {
        user: buyer.userId,
        wallet: buyer.walletAddress,
        wallet_attachment: buyer.walletAttachment,
      })
      if (useLocalSetup) {
        ensureLocalMembership({
          env,
          communityId,
          session: buyer,
        })
        ensureLocalVerification({
          env,
          session: buyer,
        })
      } else if (!skipVerification) {
        await completeUniqueHuman({ apiBaseUrl, session: buyer })
      }
      await settleListingPurchase({
        apiBaseUrl,
        env,
        communityId,
        listing: listing.id,
        buyer,
      })
      if (originalAsset.story_ip) {
        await pollOriginalClaimable({
          apiBaseUrl,
          author,
          originalAsset: originalPost.asset,
          originalStoryIp: originalAsset.story_ip,
        })
      }
    }
  }

  console.log("[smoke] story remix cycle passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
