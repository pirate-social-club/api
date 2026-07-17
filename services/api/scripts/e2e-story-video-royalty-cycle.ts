// @ts-nocheck

import { SignJWT } from "jose"
import { Interface, JsonRpcProvider, Wallet, getAddress } from "ethers"
// @ts-expect-error The API tsconfig only loads bun-types/test, but this script runs under Bun.
import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

// Live e2e for: source song IP -> locked paid video IP -> Story royalty payment
// -> parent claimable WIP increase -> buyer CDR entitlement access.
// Requires --settle-purchase because the parent royalty delta is the proof.

type E2ESession = {
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

function readEnvAlias(primary: string, fallbackName: string, fallback = ""): string {
  return readEnv(primary) || readEnv(fallbackName, fallback)
}

function requireEnv(name: string): string {
  const value = readEnv(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requireEnvAlias(primary: string, fallbackName: string): string {
  const value = readEnvAlias(primary, fallbackName)
  if (!value) throw new Error(`${primary} or ${fallbackName} is required`)
  return value
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
  const explicit = readEnvAlias("PIRATE_E2E_ENSURE_LOCAL_MEMBERSHIP", "PIRATE_SMOKE_ENSURE_LOCAL_MEMBERSHIP")
  if (explicit) return ["1", "true", "yes", "on"].includes(explicit.toLowerCase())
  const hostname = new URL(apiBaseUrl).hostname
  return hostname === "127.0.0.1" || hostname === "localhost"
}

function toRequestArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function ensureLocalMembership(input: {
  env: Record<string, string | undefined>
  communityId: string
  session: E2ESession
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
  console.log("[e2e] local membership", {
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
  session: E2ESession
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
  console.log("[e2e] local verification", {
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

async function createSession(input: {
  apiBaseUrl: string
  env: Record<string, string | undefined>
  subject: string
  privateKey?: string | null
}): Promise<E2ESession> {
  const normalizedPrivateKey = normalizePrivateKey(input.privateKey)
  const wallet = normalizedPrivateKey ? new Wallet(normalizedPrivateKey) : Wallet.createRandom()
  const jwt = await mintUpstreamJwt({
    env: input.env,
    subject: input.subject,
    walletAddress: wallet.address,
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
        type: "jwt_based_auth",
        jwt,
      },
    },
  })
  return {
    accessToken: body.access_token,
    userId: body.user.id,
    walletAddress: wallet.address,
    privateKey: wallet.privateKey,
    walletAttachment:
      body.user.primary_wallet_attachment
      ?? body.wallet_attachments?.find((attachment) => attachment.is_primary)?.wallet_attachment
      ?? body.wallet_attachments?.[0]?.wallet_attachment
      ?? null,
  }
}

async function completeUniqueHuman(input: {
  apiBaseUrl: string
  session: E2ESession
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
  console.log("[e2e] verification", {
    started: created.status,
    completed: completed.status,
  })
}

async function waitForJob(input: {
  apiBaseUrl: string
  jobId: string
  token: string
}): Promise<void> {
  const timeoutMs = Number(readEnvAlias("PIRATE_E2E_JOB_TIMEOUT_MS", "PIRATE_SMOKE_JOB_TIMEOUT_MS", "120000"))
  const intervalMs = Number(readEnvAlias("PIRATE_E2E_JOB_INTERVAL_MS", "PIRATE_SMOKE_JOB_INTERVAL_MS", "3000"))
  const startedAt = Date.now()
  let lastStatus = "unknown"

  while (Date.now() - startedAt <= timeoutMs) {
    const job = await api<{ error_code?: string | null; id: string; status: string }>({
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
  owner: E2ESession
  runId: string
}): Promise<string> {
  const created = await api<{
    community: { id: string; provisioning_state?: string | null }
    job: { id: string; status: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      display_name: `Story Video Royalty E2E ${input.runId}`,
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

  console.log("[e2e] community", {
    community: created.community.id,
    job: created.job.id,
    provisioning_state: created.community.provisioning_state ?? null,
  })
  return created.community.id
}

async function approveCommunityMembership(input: {
  apiBaseUrl: string
  applicant: E2ESession
  communityId: string
  owner: E2ESession
}): Promise<void> {
  const join = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      note: "Story video royalty e2e participant",
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/join`,
    token: input.applicant.accessToken,
  })
  if (join.status === "joined") {
    console.log("[e2e] participant membership", {
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
  console.log("[e2e] participant membership", {
    request: request.id,
    status: approved.status,
    user: input.applicant.userId,
  })
}

async function uploadSong(input: {
  apiBaseUrl: string
  communityId: string
  session: E2ESession
  title: string
  filename: string
  bytes: Uint8Array
}): Promise<string> {
  const upload = await api<{ id: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads`,
    token: input.session.accessToken,
    body: {
      artifact_kind: "primary_audio",
      mime_type: "audio/mpeg",
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
      lyrics: "Story video royalty e2e lyric",
    },
  })
  console.log("[e2e] bundle", {
    title: input.title,
    bundle: bundle.id,
    status: bundle.status ?? null,
  })
  return bundle.id
}

async function uploadVideo(input: {
  apiBaseUrl: string
  communityId: string
  session: E2ESession
  filename: string
  bytes: Uint8Array
}): Promise<{
  content_hash?: string | null
  id: string
  mime_type?: string | null
  size_bytes?: number | null
  storage_ref: string
}> {
  const digest = await crypto.subtle.digest("SHA-256", input.bytes)
  const contentHash = `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  const upload = await api<{
    id: string
    upload_session: { id: string; total_parts: number; upload_id: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads`,
    token: input.session.accessToken,
    body: {
      upload_mode: "direct_multipart",
      artifact_kind: "primary_video",
      mime_type: "video/mp4",
      filename: input.filename,
      size_bytes: input.bytes.byteLength,
      content_hash: contentHash,
    },
  })
  if (upload.upload_session.total_parts !== 1) {
    throw new Error(`expected tiny video fixture to have 1 part, got ${upload.upload_session.total_parts}`)
  }
  const signed = await api<{ url: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(upload.id)}/sessions/${encodeURIComponent(upload.upload_session.id)}/parts/1/signed-url`,
    token: input.session.accessToken,
  })
  const uploaded = await fetch(signed.url, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: toRequestArrayBuffer(input.bytes),
  })
  const etag = uploaded.headers.get("etag")
  if (!uploaded.ok || !etag) {
    throw new Error(`video part upload failed: ${uploaded.status}; etag=${etag}; body=${(await uploaded.text()).slice(0, 800)}`)
  }
  const completed = await api<{
    content_hash?: string | null
    id: string
    mime_type?: string | null
    size_bytes?: number | null
    storage_ref: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(upload.id)}/sessions/${encodeURIComponent(upload.upload_session.id)}/complete`,
    token: input.session.accessToken,
    body: {
      upload_id: upload.upload_session.upload_id,
      parts: [{ part_number: 1, etag }],
      content_hash: contentHash,
    },
  })
  console.log("[e2e] video upload", {
    upload: completed.id,
    storage_ref: completed.storage_ref,
    size_bytes: completed.size_bytes ?? input.bytes.byteLength,
  })
  return completed
}

function tinyMp4FixtureBytes(): Uint8Array {
  return new Uint8Array([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x6d, 0x70, 0x34, 0x32,
    0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x08,
    0x6d, 0x64, 0x61, 0x74,
  ])
}

async function readVideoFixture(): Promise<{ bytes: Uint8Array; filename: string }> {
  const fixturePath = readEnvAlias("PIRATE_E2E_VIDEO_FILE", "PIRATE_SMOKE_VIDEO_FILE")
  if (!fixturePath) {
    return {
      bytes: tinyMp4FixtureBytes(),
      filename: "story-video-e2e-locked.mp4",
    }
  }
  const bytes = await readFile(fixturePath)
  if (bytes.byteLength <= 0) {
    throw new Error(`video fixture is empty: ${fixturePath}`)
  }
  return {
    bytes: new Uint8Array(bytes),
    filename: basename(fixturePath),
  }
}

async function readAsset(input: {
  apiBaseUrl: string
  communityId: string
  session: E2ESession
  asset: string
}): Promise<{
  access_mode?: string | null
  commercial_rev_share_pct?: number | null
  license_preset?: string | null
  locked_delivery_status?: string | null
  publication_status?: string | null
  story_cdr_vault_uuid?: number | null
  story_derivative_parent_ip_ids?: string[] | null
  story_entitlement_token?: string | null
  story_ip?: string | null
  story_license_terms?: string | null
  story_publish_tx_ref?: string | null
  story_royalty_registration_status?: string | null
  story_status?: string | null
}> {
  return await api({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/assets/${encodeURIComponent(input.asset)}`,
    token: input.session.accessToken,
  })
}

async function createSongPost(input: {
  apiBaseUrl: string
  communityId: string
  session: E2ESession
  title: string
  bundle: string
  songMode: "original" | "remix"
  accessMode: "public" | "locked"
  rightsBasis: "original" | "derivative"
  upstreamAssetRefs?: string[] | null
}): Promise<{ post: string; asset: string }> {
  const body = await api<{ id: string; asset?: string | null }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/posts`,
    token: input.session.accessToken,
    body: {
      idempotency_key: `story-video-royalty-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      post_type: "song",
      identity_mode: "public",
      title: input.title,
      access_mode: input.accessMode,
      song_mode: input.songMode,
      rights_basis: input.rightsBasis,
      license_preset: input.rightsBasis === "original" ? "commercial-remix" : undefined,
      commercial_rev_share_pct: input.rightsBasis === "original" ? 10 : undefined,
      upstream_asset_refs: input.upstreamAssetRefs ?? undefined,
      song_artifact_bundle: input.bundle,
    },
  })
  if (!body.asset) throw new Error(`post ${body.id} did not return an asset id`)
  return {
    post: body.id,
    asset: body.asset,
  }
}

async function createLockedDerivativeVideoPost(input: {
  apiBaseUrl: string
  communityId: string
  session: E2ESession
  title: string
  upload: {
    content_hash?: string | null
    mime_type?: string | null
    size_bytes?: number | null
    storage_ref: string
  }
  upstreamAssetRefs: string[]
}): Promise<{ post: string; asset: string }> {
  const body = await api<{ id: string; asset?: string | null }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/posts`,
    token: input.session.accessToken,
    body: {
      idempotency_key: `story-video-royalty-e2e-video-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      post_type: "video",
      identity_mode: "public",
      title: input.title,
      visibility: "members_only",
      access_mode: "locked",
      rights_basis: "derivative",
      license_preset: "commercial-remix",
      commercial_rev_share_pct: 10,
      upstream_asset_refs: input.upstreamAssetRefs,
      media_refs: [{
        storage_ref: input.upload.storage_ref,
        mime_type: input.upload.mime_type || "video/mp4",
        size_bytes: input.upload.size_bytes ?? null,
        content_hash: input.upload.content_hash ?? null,
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
  buyer: E2ESession
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
  console.log("[e2e] checkout funding", {
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
  buyer: E2ESession
}): Promise<{
  fundingTxRef: string
  purchaseId: string
  quoteId: string
  settlementTxRef: string
}> {
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
  console.log("[e2e] purchase quote", {
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
  console.log("[e2e] purchase settlement", {
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
  return {
    fundingTxRef: fundingTx,
    purchaseId: settlement.id,
    quoteId: quote.id,
    settlementTxRef: settlement.settlement_tx_ref,
  }
}

async function readClaimableWipWei(input: {
  apiBaseUrl: string
  author: E2ESession
  originalAsset: string
  originalStoryIp: string
}): Promise<{
  amount: bigint
  item: { asset?: string | null; ip?: string | null; claimable_wip_wei: string; title?: string | null } | null
  items: Array<{ asset?: string | null; ip?: string | null; claimable_wip_wei: string; title?: string | null }>
}> {
  const claimable = await api<{
    total_claimable_wip_wei: string
    items: Array<{ asset?: string | null; ip?: string | null; claimable_wip_wei: string; title?: string | null }>
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: "/royalties/claimable",
    token: input.author.accessToken,
  })
  const match = claimable.items.find((item) => {
    return item.asset === input.originalAsset || item.ip?.toLowerCase() === input.originalStoryIp.toLowerCase()
  }) ?? null
  return {
    amount: match ? BigInt(match.claimable_wip_wei) : 0n,
    item: match,
    items: claimable.items,
  }
}

async function pollOriginalClaimableIncrease(input: {
  apiBaseUrl: string
  author: E2ESession
  before: bigint
  originalAsset: string
  originalStoryIp: string
}): Promise<void> {
  const timeoutMs = Number(readEnvAlias("PIRATE_E2E_CLAIMABLE_TIMEOUT_MS", "PIRATE_SMOKE_CLAIMABLE_TIMEOUT_MS", "180000"))
  const intervalMs = Number(readEnvAlias("PIRATE_E2E_CLAIMABLE_INTERVAL_MS", "PIRATE_SMOKE_CLAIMABLE_INTERVAL_MS", "5000"))
  const startedAt = Date.now()
  let lastItems: unknown[] = []

  while (Date.now() - startedAt <= timeoutMs) {
    const claimable = await readClaimableWipWei({
      apiBaseUrl: input.apiBaseUrl,
      author: input.author,
      originalAsset: input.originalAsset,
      originalStoryIp: input.originalStoryIp,
    })
    lastItems = claimable.items
    if (claimable.amount > input.before) {
      console.log("[e2e] original claimable royalty increased", {
        after_wip_wei: claimable.amount.toString(),
        asset: claimable.item?.asset ?? null,
        before_wip_wei: input.before.toString(),
        delta_wip_wei: (claimable.amount - input.before).toString(),
        ip: claimable.item?.ip ?? null,
        title: claimable.item?.title ?? null,
      })
      return
    }
    await sleep(intervalMs)
  }

  throw new Error(`original royalty did not increase within ${timeoutMs}ms from ${input.before.toString()} wei: ${JSON.stringify(lastItems)}`)
}

function resolveStoryRpcUrlForE2e(env: Record<string, string | undefined>): string {
  return env.STORY_RPC_URL?.trim() || "https://aeneid.storyrpc.io"
}

function resolveStoryChainIdForE2e(env: Record<string, string | undefined>): number {
  const parsed = Number(env.STORY_CHAIN_ID || "1315")
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1315
}

async function waitForStoryReceipt(input: {
  env: Record<string, string | undefined>
  txHash: string
}): Promise<void> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.txHash)) {
    throw new Error(`invalid Story tx hash: ${input.txHash}`)
  }
  const timeoutMs = Number(readEnvAlias("PIRATE_E2E_STORY_TX_TIMEOUT_MS", "PIRATE_SMOKE_STORY_TX_TIMEOUT_MS", "180000"))
  const intervalMs = Number(readEnvAlias("PIRATE_E2E_STORY_TX_INTERVAL_MS", "PIRATE_SMOKE_STORY_TX_INTERVAL_MS", "5000"))
  const provider = new JsonRpcProvider(resolveStoryRpcUrlForE2e(input.env), resolveStoryChainIdForE2e(input.env))
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const receipt = await provider.getTransactionReceipt(input.txHash)
    if (receipt) {
      if (receipt.status !== 1) {
        throw new Error(`Story tx failed: ${input.txHash}`)
      }
      console.log("[e2e] Story tx confirmed", {
        block: receipt.blockNumber,
        tx: input.txHash,
      })
      return
    }
    await sleep(intervalMs)
  }
  throw new Error(`Story tx receipt not found within ${timeoutMs}ms: ${input.txHash}`)
}

async function assertVideoAccessRequiresPurchase(input: {
  apiBaseUrl: string
  buyer: E2ESession
  communityId: string
  videoAsset: string
}): Promise<void> {
  const access = await api<{
    access_granted: boolean
    decision_reason: string | null
    story_cdr_access?: unknown | null
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/assets/${encodeURIComponent(input.videoAsset)}/access`,
    token: input.buyer.accessToken,
  })
  if (access.access_granted !== false || access.decision_reason !== "purchase_required" || access.story_cdr_access != null) {
    throw new Error(`video access should require purchase before settlement: ${JSON.stringify(access)}`)
  }
  console.log("[e2e] pre-purchase video access", {
    access_granted: access.access_granted,
    decision_reason: access.decision_reason,
  })
}

async function assertVideoAccessAllowed(input: {
  apiBaseUrl: string
  buyer: E2ESession
  communityId: string
  videoAsset: string
}): Promise<void> {
  const access = await api<{
    access_granted: boolean
    decision_reason: string | null
    delivery_kind: string | null
    delivery_ref: string | null
    story_cdr_access?: {
      access_scope?: string | null
      ciphertext_ref?: string | null
      mime_type?: string | null
      vault_uuid?: number | null
    } | null
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(input.communityId)}/assets/${encodeURIComponent(input.videoAsset)}/access`,
    token: input.buyer.accessToken,
  })
  if (
    access.access_granted !== true
    || access.decision_reason !== "purchase_entitlement"
    || access.delivery_kind !== "story_cdr_ref"
    || !access.delivery_ref
    || access.story_cdr_access?.access_scope !== "asset.share"
    || !access.story_cdr_access?.ciphertext_ref
    || !access.story_cdr_access?.vault_uuid
  ) {
    throw new Error(`buyer did not receive locked video CDR access after settlement: ${JSON.stringify(access)}`)
  }
  console.log("[e2e] post-purchase video access", {
    access_granted: access.access_granted,
    ciphertext_ref: access.story_cdr_access.ciphertext_ref,
    delivery_kind: access.delivery_kind,
    vault_uuid: access.story_cdr_access.vault_uuid,
  })
}

async function main(): Promise<void> {
  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Record<string, string | undefined>
  const apiBaseUrl = normalizeApiBaseUrl(readEnvAlias("PIRATE_E2E_API_BASE_URL", "PIRATE_SMOKE_API_BASE_URL", "http://127.0.0.1:8787"))
  const configuredCommunityId = readEnvAlias("PIRATE_E2E_COMMUNITY_ID", "PIRATE_SMOKE_COMMUNITY_ID")
  const shouldCreateCommunity = hasFlag("--create-community") || !configuredCommunityId
  const shouldApproveParticipants = shouldCreateCommunity || hasFlag("--approve-participants")
  let communityId = configuredCommunityId
  const configuredSourceAsset = readEnvAlias("PIRATE_E2E_SOURCE_ASSET", "PIRATE_SMOKE_SOURCE_ASSET")
  const titlePrefix = readEnvAlias("PIRATE_E2E_TITLE_PREFIX", "PIRATE_SMOKE_TITLE_PREFIX", "Story Video Royalty")
  const skipVerification = hasFlag("--skip-verification")
  const useLocalSetup = shouldUseLocalMembershipSetup(apiBaseUrl)
  const settlePurchase = hasFlag("--settle-purchase")
  if (!settlePurchase) {
    throw new Error("Pass --settle-purchase. This e2e must execute purchase settlement and prove parent royalty flow.")
  }
  if (!shouldCreateCommunity && !communityId) {
    throw new Error("PIRATE_E2E_COMMUNITY_ID or PIRATE_SMOKE_COMMUNITY_ID is required unless --create-community is passed")
  }
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`

  const sourceArtist = await createSession({
    apiBaseUrl,
    env,
    subject: readEnvAlias("PIRATE_E2E_SOURCE_SUBJECT", "PIRATE_SMOKE_SOURCE_SUBJECT", `story-video-royalty-e2e-source-${runId}`),
  })
  console.log("[e2e] source artist", {
    user: sourceArtist.userId,
    wallet: sourceArtist.walletAddress,
    wallet_attachment: sourceArtist.walletAttachment,
  })
  if (useLocalSetup) {
    ensureLocalMembership({
      env,
      communityId,
      session: sourceArtist,
    })
    ensureLocalVerification({
      env,
      session: sourceArtist,
    })
  }
  if (!skipVerification && !useLocalSetup) {
    await completeUniqueHuman({ apiBaseUrl, session: sourceArtist })
  }
  if (shouldCreateCommunity) {
    communityId = await createDisposableCommunity({
      apiBaseUrl,
      owner: sourceArtist,
      runId,
    })
  }

  const originalTitle = `${titlePrefix} Source Song ${new Date().toISOString()}`
  const originalPost = configuredSourceAsset
    ? {
        post: null,
        asset: configuredSourceAsset,
      }
    : await (async () => {
        const originalBundle = await uploadSong({
          apiBaseUrl,
          communityId,
          session: sourceArtist,
          title: originalTitle,
          filename: "story-video-e2e-original.mp3",
          bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        })
        return await createSongPost({
          apiBaseUrl,
          communityId,
          session: sourceArtist,
          title: originalTitle,
          bundle: originalBundle,
          songMode: "original",
          accessMode: "public",
          rightsBasis: "original",
        })
      })()
  const originalAsset = await readAsset({
    apiBaseUrl,
    communityId,
    session: sourceArtist,
    asset: originalPost.asset,
  })
  console.log("[e2e] original asset", {
    post: originalPost.post,
    asset: originalPost.asset,
    story_ip: originalAsset.story_ip ?? null,
    story_license_terms: originalAsset.story_license_terms ?? null,
    story_royalty_registration_status: originalAsset.story_royalty_registration_status ?? null,
  })
  if (originalAsset.story_royalty_registration_status !== "registered") {
    throw new Error(`original asset was not Story registered: ${JSON.stringify(originalAsset)}`)
  }
  if (!originalAsset.story_ip?.trim() || !originalAsset.story_license_terms?.trim()) {
    throw new Error(`original asset is missing Story IP or license terms: ${JSON.stringify(originalAsset)}`)
  }

  const catalog = configuredSourceAsset
    ? { items: [] as Array<{ asset: string; title: string; story_ip: string; story_license_terms: string }> }
    : await api<{
        items: Array<{ asset: string; title: string; story_ip: string; story_license_terms: string }>
      }>({
        apiBaseUrl,
        method: "GET",
        path: `/communities/${encodeURIComponent(communityId)}/derivative-sources?kind=song&q=${encodeURIComponent(originalTitle)}`,
        token: sourceArtist.accessToken,
      })
  if (!configuredSourceAsset) {
    console.log("[e2e] derivative sources", {
      count: catalog.items.length,
      first: catalog.items[0] ?? null,
    })
  }
  const source = configuredSourceAsset
    ? { asset: originalPost.asset }
    : catalog.items.find((item) => item.asset === originalPost.asset) ?? catalog.items[0]
  if (!source) throw new Error("original did not appear in derivative sources")
  const upstreamAssetRefs = configuredSourceAsset
    ? [`story:ip:${originalAsset.story_ip}#licenseTermsId=${originalAsset.story_license_terms}`]
    : [`story:asset:${source.asset}`]

  const useSourceAsVideoCreator = readEnvAlias("PIRATE_E2E_SOURCE_AS_VIDEO_CREATOR", "PIRATE_SMOKE_SOURCE_AS_VIDEO_CREATOR") === "1"
  const videoCreator = useSourceAsVideoCreator
    ? sourceArtist
    : await createSession({
        apiBaseUrl,
        env,
        subject: `story-video-royalty-e2e-video-creator-${runId}`,
      })
  console.log("[e2e] video creator", {
    user: videoCreator.userId,
    wallet: videoCreator.walletAddress,
    wallet_attachment: videoCreator.walletAttachment,
  })
  if (useSourceAsVideoCreator) {
    console.log("[e2e] video creator reuses source artist", {
      user: videoCreator.userId,
    })
  } else if (useLocalSetup) {
    ensureLocalMembership({
      env,
      communityId,
      session: videoCreator,
    })
    ensureLocalVerification({
      env,
      session: videoCreator,
    })
  } else if (!skipVerification) {
    await completeUniqueHuman({ apiBaseUrl, session: videoCreator })
  }
  if (!useSourceAsVideoCreator && shouldApproveParticipants) {
    await approveCommunityMembership({
      apiBaseUrl,
      applicant: videoCreator,
      communityId,
      owner: sourceArtist,
    })
  }

  const buyer = await createSession({
    apiBaseUrl,
    env,
    subject: `story-video-royalty-e2e-buyer-${runId}`,
    privateKey: requireEnvAlias("PIRATE_E2E_BUYER_PRIVATE_KEY", "PIRATE_SMOKE_BUYER_PRIVATE_KEY"),
  })
  console.log("[e2e] buyer", {
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
  if (shouldApproveParticipants) {
    await approveCommunityMembership({
      apiBaseUrl,
      applicant: buyer,
      communityId,
      owner: sourceArtist,
    })
  }

  const videoFixture = await readVideoFixture()
  const videoTitle = `${titlePrefix} Locked Video ${new Date().toISOString()}`
  const videoUpload = await uploadVideo({
    apiBaseUrl,
    communityId,
    session: videoCreator,
    filename: videoFixture.filename,
    bytes: videoFixture.bytes,
  })
  const videoPost = await createLockedDerivativeVideoPost({
    apiBaseUrl,
    communityId,
    session: videoCreator,
    title: videoTitle,
    upload: videoUpload,
    upstreamAssetRefs,
  })
  const videoAsset = await readAsset({
    apiBaseUrl,
    communityId,
    session: videoCreator,
    asset: videoPost.asset,
  })
  console.log("[e2e] locked derivative video asset", {
    post: videoPost.post,
    asset: videoPost.asset,
    access_mode: videoAsset.access_mode ?? null,
    locked_delivery_status: videoAsset.locked_delivery_status ?? null,
    story_cdr_vault_uuid: videoAsset.story_cdr_vault_uuid ?? null,
    story_entitlement_token: videoAsset.story_entitlement_token ?? null,
    story_ip: videoAsset.story_ip ?? null,
    story_publish_tx_ref: videoAsset.story_publish_tx_ref ?? null,
    story_royalty_registration_status: videoAsset.story_royalty_registration_status ?? null,
    parents: videoAsset.story_derivative_parent_ip_ids ?? null,
  })
  if (videoAsset.story_royalty_registration_status !== "registered" || !videoAsset.story_ip?.trim()) {
    throw new Error(`locked video asset was not Story registered: ${JSON.stringify(videoAsset)}`)
  }
  const parentIps = videoAsset.story_derivative_parent_ip_ids ?? []
  if (!parentIps.some((parentIp) => parentIp.toLowerCase() === originalAsset.story_ip!.toLowerCase())) {
    throw new Error(`locked video asset missing source song parent IP: ${JSON.stringify(videoAsset)}`)
  }
  if (videoAsset.access_mode !== "locked") {
    throw new Error(`video asset is not locked: ${JSON.stringify(videoAsset)}`)
  }
  if (videoAsset.locked_delivery_status !== "ready" || !videoAsset.story_cdr_vault_uuid || !videoAsset.story_entitlement_token) {
    throw new Error(`locked video CDR delivery is not ready: ${JSON.stringify(videoAsset)}`)
  }

  const claimableBefore = await readClaimableWipWei({
    apiBaseUrl,
    author: sourceArtist,
    originalAsset: originalPost.asset,
    originalStoryIp: originalAsset.story_ip,
  })
  console.log("[e2e] original claimable before purchase", {
    asset: claimableBefore.item?.asset ?? originalPost.asset,
    ip: claimableBefore.item?.ip ?? originalAsset.story_ip,
    claimable_wip_wei: claimableBefore.amount.toString(),
  })

  const listing = await api<{ id: string; status: string }>({
    apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId)}/listings`,
    token: videoCreator.accessToken,
    body: {
      asset: videoPost.asset,
      price_cents: Number(readEnvAlias("PIRATE_E2E_PRICE_CENTS", "PIRATE_SMOKE_PRICE_CENTS", "399")),
      regional_pricing_enabled: false,
      status: "active",
    },
  })
  console.log("[e2e] video listing", listing)

  await assertVideoAccessRequiresPurchase({
    apiBaseUrl,
    buyer,
    communityId,
    videoAsset: videoPost.asset,
  })

  const settlement = await settleListingPurchase({
    apiBaseUrl,
    env,
    communityId,
    listing: listing.id,
    buyer,
  })
  await waitForStoryReceipt({
    env,
    txHash: settlement.settlementTxRef,
  })
  await pollOriginalClaimableIncrease({
    apiBaseUrl,
    author: sourceArtist,
    before: claimableBefore.amount,
    originalAsset: originalPost.asset,
    originalStoryIp: originalAsset.story_ip,
  })
  await assertVideoAccessAllowed({
    apiBaseUrl,
    buyer,
    communityId,
    videoAsset: videoPost.asset,
  })

  console.log("[e2e] story video royalty cycle passed", {
    buyer: buyer.userId,
    funding_tx_ref: settlement.fundingTxRef,
    listing: listing.id,
    purchase: settlement.purchaseId,
    quote: settlement.quoteId,
    settlement_tx_ref: settlement.settlementTxRef,
    source_asset: originalPost.asset,
    source_ip: originalAsset.story_ip,
    video_asset: videoPost.asset,
    video_ip: videoAsset.story_ip,
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
