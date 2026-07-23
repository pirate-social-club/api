// @ts-nocheck

import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { SignJWT } from "jose"
import { Wallet } from "ethers"
import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
// @ts-expect-error The API tsconfig only loads bun-types/test, but this script runs under Bun.
import { Database } from "bun:sqlite"
import { publicCommunityId } from "../src/lib/public-ids"
import { allocationAttributionHeaders } from "./_lib/allocation-attribution"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

type TimingKind = "song-public" | "song-locked" | "video-public" | "video-locked"
type Session = {
  accessToken: string
  privateKey: string
  userId: string
  walletAddress: string
  walletAttachment: string | null
}
type TimingEvent = {
  run_id: string
  run_index: number
  summary_excluded?: boolean
  target: string
  kind: TimingKind
  stage: string
  status: "ok" | "error"
  ms: number
  ts_iso: string
  meta?: Record<string, unknown>
  error?: string
}
type ApiVersionPayload = {
  build_timestamp?: string | null
  environment?: string | null
  git_ref?: string | null
  git_sha?: string | null
  service?: string | null
}

const env = {
  ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
  ...readDevVarsFromCwd(),
  ...process.env,
} as Record<string, string | undefined>

function readFlag(name: string): string | null {
  const prefix = `${name}=`
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function printUsage(): void {
  console.log(`
Usage:
  bun run timing:fixtures
  bun run timing:submission-e2e --file ./scripts/generated-fixtures/4mb.mp4 --poster-file ./scripts/generated-fixtures/poster.jpg

Required:
  --community-id,
  PIRATE_TIMING_COMMUNITY_ID       Community id to publish into. If omitted, creates a temporary open timing community per run.
  --file, PIRATE_TIMING_FILE       Real audio/video file to upload.

Common options:
  PIRATE_TIMING_API_BASE_URL       Defaults to http://127.0.0.1:8787.
  PIRATE_TIMING_ACCESS_TOKEN       Optional existing Bearer token; skips JWT minting.
  --kind,
  PIRATE_TIMING_KIND               song-public | song-locked | video-public | video-locked. Defaults to video-locked.
  PIRATE_TIMING_RUNS               Number of measured runs. Defaults to 1; use 20 for real staging measurements.
  PIRATE_TIMING_WARMUP_RUNS        Runs to execute and exclude from summary. Defaults to 0.
  PIRATE_TIMING_REQUEST_TIMEOUT_MS Per-request timeout. Defaults to 300000.
  --poster-file                    Optional real poster image for video runs.
  --output                         Optional JSONL output path.
  --expect-git-sha,
  PIRATE_TIMING_EXPECT_GIT_SHA     Fail if /__version does not match before/after each run.
  --access-token                   Same as PIRATE_TIMING_ACCESS_TOKEN.
  --skip-verification              Skip remote verification session completion.
  --skip-post-altcha               Do not solve/send post_create ALTCHA proof.
  --skip-owner-access              Skip final owner access read. Localhost only unless --allow-remote-skip-owner-access is set.
  --allow-remote-skip-owner-access Permit --skip-owner-access against non-local API URLs.
  --skip-song-preview-wait         Try song post creation without waiting for preview first.

Output:
  One JSON object per stage, plus a summary table with mean, p50, and p95.
`)
}

function readEnv(name: string, fallback = ""): string {
  const cli = readFlag(`--${name.toLowerCase().replaceAll("_", "-")}`)
  if (cli) return cli
  return env[name]?.trim() || fallback
}

function requireEnv(name: string): string {
  const value = readEnv(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "")
}

function isLocalApiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
  } catch {
    return false
  }
}

function isStagingApiUrl(value: string): boolean {
  try {
    return new URL(value).hostname.includes("staging")
  } catch {
    return false
  }
}

function rawId(value: string, prefix: string): string {
  return value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : value
}

function unixSeconds(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000)
}

function resolveSqlitePathFromUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback
  return raw.startsWith("file:") ? raw.slice("file:".length) : raw
}

function mimeFromFilename(filename: string, fallback: string): string {
  const ext = extname(filename).toLowerCase()
  if (ext === ".mp3") return "audio/mpeg"
  if (ext === ".wav") return "audio/wav"
  if (ext === ".m4a") return "audio/mp4"
  if (ext === ".mp4") return "video/mp4"
  if (ext === ".mov") return "video/quicktime"
  if (ext === ".webm") return "video/webm"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".png") return "image/png"
  if (ext === ".webp") return "image/webp"
  return fallback
}

function percentile(values: number[], pct: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1))
  return sorted[index]!
}

function summarize(events: TimingEvent[]): void {
  const includedEvents = events.filter((event) => event.summary_excluded !== true)
  const okEvents = includedEvents.filter((event) => event.status === "ok")
  const stages = [...new Set(includedEvents.map((event) => event.stage))]
  console.log("\n[timing] summary")
  console.log("stage\tok\ttotal\tmean_ms\tp50_ms\tp95_ms")
  for (const stage of stages) {
    const values = okEvents.filter((event) => event.stage === stage).map((event) => event.ms)
    const total = includedEvents.filter((event) => event.stage === stage).length
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
    console.log([
      stage,
      String(values.length),
      String(total),
      mean.toFixed(1),
      percentile(values, 50).toFixed(1),
      percentile(values, 95).toFixed(1),
    ].join("\t"))
  }

  const failureStages = stages
    .map((stage) => {
      const failures = includedEvents.filter((event) => event.stage === stage && event.status === "error")
      return {
        stage,
        failures,
      }
    })
    .filter((entry) => entry.failures.length > 0)
  if (failureStages.length) {
    console.log("\n[timing] failures")
    console.log("stage\tfailed\ttotal\tlatest_error")
    for (const entry of failureStages) {
      const total = includedEvents.filter((event) => event.stage === entry.stage).length
      const latest = entry.failures.at(-1)
      console.log([
        entry.stage,
        String(entry.failures.length),
        String(total),
        latest?.error ?? "",
      ].join("\t"))
    }
  }
}

async function requestJson<T>(input: {
  apiBaseUrl: string
  body?: unknown
  bytes?: Uint8Array
  contentType?: string
  headers?: Record<string, string>
  method?: string
  ok?: number[]
  path: string
  timeoutMs?: number
  token?: string | null
}): Promise<T> {
  let body: BodyInit | null = null
  const headers: Record<string, string> = {}
  if (input.token) headers.authorization = `Bearer ${input.token}`
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers[key] = value
  }
  if (input.bytes) {
    const copy = new ArrayBuffer(input.bytes.byteLength)
    new Uint8Array(copy).set(input.bytes)
    body = copy
    headers["content-type"] = input.contentType ?? "application/octet-stream"
  } else if (input.body != null) {
    body = JSON.stringify(input.body)
    headers["content-type"] = "application/json"
  }

  const method = input.method ?? (body == null ? "GET" : "POST")
  const timeoutMs = input.timeoutMs ?? Number(readEnv("PIRATE_TIMING_REQUEST_TIMEOUT_MS", "300000"))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${input.apiBaseUrl}${input.path}`, {
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
    return parsed as T
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${method} ${input.path} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readApiVersion(apiBaseUrl: string): Promise<ApiVersionPayload> {
  return requestJson<ApiVersionPayload>({
    apiBaseUrl,
    path: "/__version",
  })
}

async function recordTimingEvent(input: {
  event: TimingEvent
  events: TimingEvent[]
  outputPath: string | null
}): Promise<void> {
  input.events.push(input.event)
  console.log(JSON.stringify(input.event))
  if (input.outputPath) {
    await appendFile(input.outputPath, `${JSON.stringify(input.event)}\n`, "utf8")
  }
}

async function assertApiVersion(input: {
  apiBaseUrl: string
  events: TimingEvent[]
  expectedGitSha: string
  kind: TimingKind
  outputPath: string | null
  outputTarget: string
  runId: string
  runIndex: number
  stage: string
  summaryExcluded: boolean
}): Promise<void> {
  const startedAt = performance.now()
  try {
    const version = await readApiVersion(input.apiBaseUrl)
    if (version.git_sha !== input.expectedGitSha) {
      throw new Error(`expected API git_sha ${input.expectedGitSha}, got ${version.git_sha ?? "null"}`)
    }
    await recordTimingEvent({
      events: input.events,
      outputPath: input.outputPath,
      event: {
        run_id: input.runId,
        run_index: input.runIndex,
        summary_excluded: input.summaryExcluded || undefined,
        target: input.outputTarget,
        kind: input.kind,
        stage: input.stage,
        status: "ok",
        ms: performance.now() - startedAt,
        ts_iso: new Date().toISOString(),
        meta: version,
      },
    })
  } catch (error) {
    await recordTimingEvent({
      events: input.events,
      outputPath: input.outputPath,
      event: {
        run_id: input.runId,
        run_index: input.runIndex,
        summary_excluded: input.summaryExcluded || undefined,
        target: input.outputTarget,
        kind: input.kind,
        stage: input.stage,
        status: "error",
        ms: performance.now() - startedAt,
        ts_iso: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}

async function solveAltchaProof(input: {
  action: string
  apiBaseUrl: string
  scope: "post_create"
  token: string
}): Promise<string> {
  const challenge = await requestJson<Challenge>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/verification/altcha/challenge?scope=${encodeURIComponent(input.scope)}&action=${encodeURIComponent(input.action)}`,
    token: input.token,
  })
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) {
    throw new Error("ALTCHA challenge did not solve")
  }
  return btoa(JSON.stringify({ challenge, solution } satisfies Payload))
}

async function uploadCommunityMedia(input: {
  apiBaseUrl: string
  file: { bytes: Uint8Array; filename: string; mimeType: string }
  token: string
}): Promise<{ media_ref: string; mime_type: string; size_bytes: number }> {
  const formData = new FormData()
  formData.set("kind", "post_image")
  formData.set("file", new File([input.file.bytes], input.file.filename, { type: input.file.mimeType }))
  const timeoutMs = Number(readEnv("PIRATE_TIMING_REQUEST_TIMEOUT_MS", "300000"))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${input.apiBaseUrl}/community-media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
      },
      body: formData,
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null
    if (response.status !== 201) {
      throw new Error(`POST /community-media failed with ${response.status}: ${text}`)
    }
    return parsed
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`POST /community-media timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function mintUpstreamJwt(input: {
  apiBaseUrl: string
  subject: string
  walletAddress: string
}): Promise<string> {
  const staging = isStagingApiUrl(input.apiBaseUrl)
  const explicitIssuer = process.env.AUTH_UPSTREAM_JWT_ISSUER?.trim() || process.env.JWT_BASED_AUTH_ISSUERS?.split(",")[0]?.trim()
  const explicitAudience = process.env.AUTH_UPSTREAM_JWT_AUDIENCE?.trim() || process.env.JWT_BASED_AUTH_AUDIENCE?.trim()
  const issuer = (explicitIssuer || (staging ? "pirate-staging-upstream" : (env.AUTH_UPSTREAM_JWT_ISSUER || env.JWT_BASED_AUTH_ISSUERS || "pirate-dev")))
    .split(",")[0]!
    .trim()
  const audience = explicitAudience || (staging ? "pirate-api-staging" : env.AUTH_UPSTREAM_JWT_AUDIENCE || env.JWT_BASED_AUTH_AUDIENCE || "pirate-api")
  const secret = env.AUTH_UPSTREAM_JWT_SHARED_SECRET || env.JWT_BASED_AUTH_SHARED_SECRET
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
  accessToken?: string | null
  apiBaseUrl: string
  subject: string
}): Promise<Session> {
  if (input.accessToken) {
    const user = await requestJson<{ id?: string; user_id?: string }>({
      apiBaseUrl: input.apiBaseUrl,
      path: "/users/me",
      token: input.accessToken,
    })
    const userId = user.id ?? user.user_id
    if (!userId) throw new Error("/users/me did not return a user id")
    return {
      accessToken: input.accessToken,
      privateKey: "",
      userId,
      walletAddress: "",
      walletAttachment: null,
    }
  }

  const wallet = Wallet.createRandom()
  const jwt = await mintUpstreamJwt({
    apiBaseUrl: input.apiBaseUrl,
    subject: input.subject,
    walletAddress: wallet.address,
  })
  const body = await requestJson<{
    access_token: string
    user: { id: string; primary_wallet_attachment?: string | null }
    wallet_attachments?: Array<{ wallet_attachment: string; is_primary?: boolean | null }>
  }>({
    apiBaseUrl: input.apiBaseUrl,
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
    privateKey: wallet.privateKey,
    userId: body.user.id,
    walletAddress: wallet.address,
    walletAttachment:
      body.user.primary_wallet_attachment
      ?? body.wallet_attachments?.find((attachment) => attachment.is_primary)?.wallet_attachment
      ?? body.wallet_attachments?.[0]?.wallet_attachment
      ?? null,
  }
}

async function completeUniqueHuman(input: {
  apiBaseUrl: string
  session: Session
}): Promise<void> {
  const created = await requestJson<{ id: string }>({
    apiBaseUrl: input.apiBaseUrl,
    path: "/verification-sessions",
    token: input.session.accessToken,
    body: {
      provider: "self",
      requested_capabilities: ["unique_human", "age_over_18"],
    },
  })
  await requestJson({
    apiBaseUrl: input.apiBaseUrl,
    path: `/verification-sessions/${encodeURIComponent(created.id)}/complete`,
    token: input.session.accessToken,
    body: {},
    ok: [200],
  })
}

async function createTimingCommunity(input: {
  apiBaseUrl: string
  runId: string
  token: string
}): Promise<string> {
  const created = await requestJson<{
    community: { id?: string; community_id?: string; provisioning_state?: string | null }
    job?: { id?: string; status?: string | null; error_code?: string | null } | null
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: "/communities",
    token: input.token,
    headers: allocationAttributionHeaders("api-script:timing-submission-e2e"),
    body: {
      display_name: `Timing E2E ${input.runId}`,
      description: "Temporary staging timing community for real-file submission measurements.",
      governance_mode: "centralized",
      membership_mode: "open",
      default_age_gate_policy: "none",
      allow_anonymous_identity: false,
      handle_policy: {
        policy_template: "standard",
      },
    },
    ok: [202],
  })
  const communityId = created.community.community_id ?? created.community.id?.replace(/^com_/, "")
  if (!communityId) throw new Error("community create response did not include community id")
  const jobId = created.job?.id
  if (jobId && created.job?.status !== "succeeded") {
    await pollUntil({
      intervalMs: 3000,
      timeoutMs: Number(readEnv("PIRATE_TIMING_COMMUNITY_READY_TIMEOUT_MS", "120000")),
      read: () => requestJson<{ id: string; status: string; error_code?: string | null }>({
        apiBaseUrl: input.apiBaseUrl,
        path: `/jobs/${encodeURIComponent(jobId)}`,
        token: input.token,
      }),
      ready: (job) => {
        if (job.status === "failed") {
          throw new Error(`community provisioning job ${job.id} failed: ${job.error_code ?? "unknown"}`)
        }
        return job.status === "succeeded"
      },
    })
  }
  return communityId
}

async function ensureRemoteMembership(input: {
  apiBaseUrl: string
  communityId: string
  session: Session
}): Promise<void> {
  const joined = await requestJson<{ status?: string | null }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      note: "Timing harness publisher",
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/join`,
    token: input.session.accessToken,
  })
  if (joined.status !== "joined") {
    throw new Error(`fixed remote timing community did not join immediately; status=${joined.status ?? "unknown"}`)
  }
}

function ensureLocalMembership(input: {
  communityId: string
  session: Session
}): void {
  const root = env.LOCAL_COMMUNITY_DB_ROOT?.trim()
  if (!root) throw new Error("LOCAL_COMMUNITY_DB_ROOT is required for local membership setup")
  const localDevVars = readDevVarsFromCwd()
  const communityDbRoot = localDevVars.LOCAL_COMMUNITY_DB_ROOT?.trim() || root
  const controlPlaneDb = resolveSqlitePathFromUrl(
    localDevVars.CONTROL_PLANE_DATABASE_URL ?? env.CONTROL_PLANE_DATABASE_URL,
    ".local/control-plane.db",
  )
  const rawUserId = rawId(input.session.userId, "usr")
  const rawCommunityId = rawId(input.communityId, "com")
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
}

function ensureLocalVerification(input: {
  session: Session
}): void {
  const localDevVars = readDevVarsFromCwd()
  const controlPlaneDb = resolveSqlitePathFromUrl(
    localDevVars.CONTROL_PLANE_DATABASE_URL ?? env.CONTROL_PLANE_DATABASE_URL,
    ".local/control-plane.db",
  )
  const rawUserId = rawId(input.session.userId, "usr")
  const now = new Date().toISOString()
  const verifiedAt = unixSeconds(now)
  const capabilities = {
    unique_human: {
      state: "verified",
      provider: "self",
      proof_type: "unique_human",
      mechanism: "timing_harness",
      verified_at: verifiedAt,
    },
    age_over_18: {
      state: "verified",
      provider: "self",
      proof_type: "age_over_18",
      mechanism: "timing_harness",
      verified_at: verifiedAt,
    },
    minimum_age: {
      state: "verified",
      value: 18,
      provider: "self",
      proof_type: "minimum_age",
      mechanism: "timing_harness",
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
}

async function createSongArtifactUpload(input: {
  apiBaseUrl: string
  artifactKind: "primary_audio" | "primary_video"
  communityId: string
  file: { bytes: Uint8Array; filename: string; mimeType: string }
  token: string
}): Promise<{ id: string; storage_ref: string }> {
  return await requestJson<{ id: string; storage_ref: string }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads`,
    token: input.token,
    body: {
      artifact_kind: input.artifactKind,
      mime_type: input.file.mimeType,
      filename: input.file.filename,
      size_bytes: input.file.bytes.byteLength,
    },
  })
}

async function uploadSongArtifactContent(input: {
  apiBaseUrl: string
  communityId: string
  file: { bytes: Uint8Array; filename: string; mimeType: string }
  token: string
  uploadId: string
}): Promise<void> {
  await requestJson({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/song-artifact-uploads/${encodeURIComponent(input.uploadId)}/content`,
    token: input.token,
    bytes: input.file.bytes,
    contentType: "application/octet-stream",
    ok: [200],
  })
}

async function pollUntil<T>(input: {
  intervalMs: number
  timeoutMs: number
  read: () => Promise<T>
  ready: (value: T) => boolean
}): Promise<T> {
  const startedAt = Date.now()
  let lastValue: T | null = null
  while (Date.now() - startedAt < input.timeoutMs) {
    lastValue = await input.read()
    if (input.ready(lastValue)) return lastValue
    await new Promise((resolvePromise) => setTimeout(resolvePromise, input.intervalMs))
  }
  throw new Error(`timed out after ${input.timeoutMs}ms; last=${JSON.stringify(lastValue)}`)
}

async function runOne(input: {
  apiBaseUrl: string
  communityId: string | null
  events: TimingEvent[]
  kind: TimingKind
  outputTarget: string
  recordEvent: (event: TimingEvent) => Promise<void>
  pollIntervalMs: number
  readyTimeoutMs: number
  runIndex: number
  runId: string
  summaryExcluded: boolean
  skipVerification: boolean
  file: { bytes: Uint8Array; filename: string; mimeType: string }
  posterFile?: { bytes: Uint8Array; filename: string; mimeType: string } | null
}): Promise<void> {
  const locked = input.kind.endsWith("-locked")
  const song = input.kind.startsWith("song-")
  const title = `Timing ${input.kind} ${new Date().toISOString()} ${Math.random().toString(16).slice(2)}`
  let session: Session | null = null
  let assetId: string | null = null
  let postAltcha: string | null = null

  async function measure<T>(stage: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const startedAt = performance.now()
    try {
      const result = await fn()
      const event = {
        run_id: input.runId,
        run_index: input.runIndex,
        summary_excluded: input.summaryExcluded || undefined,
        target: input.outputTarget,
        kind: input.kind,
        stage,
        status: "ok" as const,
        ms: performance.now() - startedAt,
        ts_iso: new Date().toISOString(),
        meta,
      }
      await input.recordEvent(event)
      return result
    } catch (error) {
      const event = {
        run_id: input.runId,
        run_index: input.runIndex,
        summary_excluded: input.summaryExcluded || undefined,
        target: input.outputTarget,
        kind: input.kind,
        stage,
        status: "error" as const,
        ms: performance.now() - startedAt,
        ts_iso: new Date().toISOString(),
        meta,
        error: error instanceof Error ? error.message : String(error),
      }
      await input.recordEvent(event)
      throw error
    }
  }

  session = await measure("auth", () => createSession({
    accessToken: readFlag("--access-token") || readEnv("PIRATE_TIMING_ACCESS_TOKEN"),
    apiBaseUrl: input.apiBaseUrl,
    subject: `timing-${input.kind}-${Date.now()}-${input.runIndex}`,
  }))

  if (input.communityId) {
    if (isLocalApiUrl(input.apiBaseUrl) && !hasFlag("--no-local-membership-setup")) {
      await measure("local_membership_setup", async () => {
        ensureLocalMembership({
          communityId: input.communityId!,
          session: session!,
        })
      })
      await measure("local_verification_setup", async () => {
        ensureLocalVerification({
          session: session!,
        })
      })
    } else if (!isLocalApiUrl(input.apiBaseUrl) && !hasFlag("--no-remote-membership-join")) {
      await measure("remote_membership_join", () => ensureRemoteMembership({
        apiBaseUrl: input.apiBaseUrl,
        communityId: input.communityId!,
        session: session!,
      }))
    }
  }

  if (!input.skipVerification && !isLocalApiUrl(input.apiBaseUrl)) {
    await measure("verification", () => completeUniqueHuman({
      apiBaseUrl: input.apiBaseUrl,
      session: session!,
    }))
  }

  const communityId = input.communityId ?? await measure("community_create", () => createTimingCommunity({
    apiBaseUrl: input.apiBaseUrl,
    runId: input.runId,
    token: session!.accessToken,
  }))
  const communityContextEvent = {
    run_id: input.runId,
    run_index: input.runIndex,
    summary_excluded: input.summaryExcluded || undefined,
    target: input.outputTarget,
    kind: input.kind,
    stage: "community_context",
    status: "ok" as const,
    ms: 0,
    ts_iso: new Date().toISOString(),
    meta: { community_id: communityId.startsWith("com_") ? communityId : publicCommunityId(communityId) },
  }
  input.events.push(communityContextEvent)
  console.log(JSON.stringify(communityContextEvent))

  if (!hasFlag("--skip-post-altcha")) {
    postAltcha = await measure("altcha_post_create", () => solveAltchaProof({
      action: `community:${communityId.startsWith("com_") ? communityId : publicCommunityId(communityId)}`,
      apiBaseUrl: input.apiBaseUrl,
      scope: "post_create",
      token: session!.accessToken,
    }))
  }

  if (song) {
    const upload = await measure("upload_intent", () => createSongArtifactUpload({
      apiBaseUrl: input.apiBaseUrl,
      artifactKind: "primary_audio",
      communityId,
      file: input.file,
      token: session!.accessToken,
    }), {
      bytes: input.file.bytes.byteLength,
      filename: input.file.filename,
    })
    await measure("upload_bytes", () => uploadSongArtifactContent({
      apiBaseUrl: input.apiBaseUrl,
      communityId,
      file: input.file,
      token: session!.accessToken,
      uploadId: upload.id,
    }), {
      bytes: input.file.bytes.byteLength,
      filename: input.file.filename,
    })
    const bundle = await measure("bundle_create", () => requestJson<{
      id: string
      preview_status?: string | null
    }>({
      apiBaseUrl: input.apiBaseUrl,
      path: `/communities/${encodeURIComponent(communityId)}/song-artifacts`,
      token: session!.accessToken,
      body: {
        primary_audio: {
          song_artifact_upload: upload.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        title,
        lyrics: "Timing harness lyric",
      },
    }))
    if (locked && !hasFlag("--skip-song-preview-wait")) {
      await measure("preview_wait", () => pollUntil({
        intervalMs: input.pollIntervalMs,
        timeoutMs: Number(readEnv("PIRATE_TIMING_PREVIEW_TIMEOUT_MS", "120000")),
        read: () => requestJson<{ preview_status?: string | null }>({
          apiBaseUrl: input.apiBaseUrl,
          path: `/communities/${encodeURIComponent(communityId)}/song-artifacts/${encodeURIComponent(bundle.id)}`,
          token: session!.accessToken,
        }),
        ready: (value) => value.preview_status === "completed",
      }))
    }
    const post = await measure("post_create", () => requestJson<{ id: string; asset?: string | null }>({
      apiBaseUrl: input.apiBaseUrl,
      headers: postAltcha ? { "x-pirate-altcha": postAltcha } : undefined,
      path: `/communities/${encodeURIComponent(communityId)}/posts`,
      token: session!.accessToken,
      body: {
        idempotency_key: `timing-song-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        post_type: "song",
        identity_mode: "public",
        title,
        access_mode: locked ? "locked" : undefined,
        song_mode: "original",
        rights_basis: "original",
        license_preset: locked ? "commercial-remix" : undefined,
        commercial_rev_share_pct: locked ? 10 : undefined,
        song_artifact_bundle: bundle.id,
      },
    }))
    assetId = post.asset ?? null
  } else {
    const videoUpload = await measure("upload_intent", () => createSongArtifactUpload({
      apiBaseUrl: input.apiBaseUrl,
      artifactKind: "primary_video",
      communityId,
      file: input.file,
      token: session!.accessToken,
    }), {
      bytes: input.file.bytes.byteLength,
      filename: input.file.filename,
    })
    const [, posterUpload] = await Promise.all([
      measure("upload_bytes", () => uploadSongArtifactContent({
        apiBaseUrl: input.apiBaseUrl,
        communityId,
        file: input.file,
        token: session!.accessToken,
        uploadId: videoUpload.id,
      }), {
        bytes: input.file.bytes.byteLength,
        filename: input.file.filename,
      }),
      input.posterFile
        ? measure("upload_poster", () => uploadCommunityMedia({
            apiBaseUrl: input.apiBaseUrl,
            file: input.posterFile!,
            token: session!.accessToken,
          }), {
            bytes: input.posterFile.bytes.byteLength,
            filename: input.posterFile.filename,
          })
        : Promise.resolve({
            media_ref: "https://media.test/timing-video-poster.jpg",
            mime_type: "image/jpeg",
            size_bytes: 0,
          }),
    ])
    const post = await measure("post_create", () => requestJson<{ id: string; asset?: string | null }>({
      apiBaseUrl: input.apiBaseUrl,
      headers: postAltcha ? { "x-pirate-altcha": postAltcha } : undefined,
      path: `/communities/${encodeURIComponent(communityId)}/posts`,
      token: session!.accessToken,
      body: {
        idempotency_key: `timing-video-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        post_type: "video",
        identity_mode: "public",
        title,
        visibility: "members_only",
        access_mode: locked ? "locked" : undefined,
        license_preset: locked ? "non-commercial" : undefined,
        rights_basis: "original",
        media_refs: [{
          storage_ref: videoUpload.storage_ref,
          mime_type: input.file.mimeType,
          size_bytes: input.file.bytes.byteLength,
          content_hash: undefined,
          poster_ref: posterUpload.media_ref,
          poster_mime_type: posterUpload.mime_type,
          poster_size_bytes: posterUpload.size_bytes,
          poster_width: 1280,
          poster_height: 720,
          poster_frame_ms: 0,
        }],
      },
    }))
    assetId = post.asset ?? null
  }

  if (assetId && locked) {
    const assetAfterPost = await measure("asset_after_post", () => requestJson<{
      access_mode?: string | null
      locked_delivery_error?: string | null
      locked_delivery_status?: string | null
      story_royalty_registration_status?: string | null
      story_status?: string | null
    }>({
      apiBaseUrl: input.apiBaseUrl,
      path: `/communities/${encodeURIComponent(communityId)}/assets/${encodeURIComponent(assetId!)}`,
      token: session!.accessToken,
    }))
    const assetStateEvent = {
      run_id: input.runId,
      run_index: input.runIndex,
      summary_excluded: input.summaryExcluded || undefined,
      target: input.outputTarget,
      kind: input.kind,
      stage: "asset_after_post_state",
      status: "ok" as const,
      ms: 0,
      ts_iso: new Date().toISOString(),
      meta: assetAfterPost,
    }
    input.events.push(assetStateEvent)
    console.log(JSON.stringify(assetStateEvent))

    await measure("listing_create", () => requestJson({
      apiBaseUrl: input.apiBaseUrl,
      path: `/communities/${encodeURIComponent(communityId)}/listings`,
      token: session!.accessToken,
      body: {
        asset: assetId,
        price_cents: Number(readEnv("PIRATE_TIMING_PRICE_CENTS", "399")),
        regional_pricing_enabled: false,
        status: "active",
      },
    }))
    await measure("job_run_to_ready", () => pollUntil({
      intervalMs: input.pollIntervalMs,
      timeoutMs: input.readyTimeoutMs,
      read: () => requestJson<{
        locked_delivery_error?: string | null
        locked_delivery_status?: string | null
        story_royalty_registration_status?: string | null
      }>({
        apiBaseUrl: input.apiBaseUrl,
        path: `/communities/${encodeURIComponent(communityId)}/assets/${encodeURIComponent(assetId!)}`,
        token: session!.accessToken,
      }),
      ready: (asset) => {
        if (asset.locked_delivery_status === "failed") {
          throw new Error(asset.locked_delivery_error || "locked delivery failed")
        }
        return asset.locked_delivery_status === "ready"
      },
    }))
    if (!hasFlag("--skip-owner-access")) {
      await measure("owner_access_ready", () => requestJson({
        apiBaseUrl: input.apiBaseUrl,
        path: `/communities/${encodeURIComponent(communityId)}/assets/${encodeURIComponent(assetId!)}/access`,
        token: session!.accessToken,
      }))
    }
  }
}

async function readFixture(path: string, fallbackMime: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
  if (!existsSync(path)) throw new Error(`${path} does not exist`)
  const bytes = new Uint8Array(await readFile(path))
  return {
    bytes,
    filename: basename(path),
    mimeType: mimeFromFilename(path, fallbackMime),
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage()
    return
  }

  const apiBaseUrl = normalizeApiBaseUrl(readEnv("PIRATE_TIMING_API_BASE_URL", "http://127.0.0.1:8787"))
  const communityId = (readFlag("--community-id") || readEnv("PIRATE_TIMING_COMMUNITY_ID") || "").replace(/^com_/, "") || null
  const kind = (readFlag("--kind") || readEnv("PIRATE_TIMING_KIND", "video-locked")) as TimingKind
  if (!["song-public", "song-locked", "video-public", "video-locked"].includes(kind)) {
    throw new Error(`PIRATE_TIMING_KIND must be song-public, song-locked, video-public, or video-locked; got ${kind}`)
  }
  const filePath = readFlag("--file") || readEnv("PIRATE_TIMING_FILE")
  if (!filePath) throw new Error("--file or PIRATE_TIMING_FILE is required")
  const posterPath = readFlag("--poster-file") || readEnv("PIRATE_TIMING_POSTER_FILE")
  const runs = Math.max(1, Number(readEnv("PIRATE_TIMING_RUNS", "1")))
  const warmupRuns = Math.max(0, Number(readEnv("PIRATE_TIMING_WARMUP_RUNS", "0")))
  const pollIntervalMs = Math.max(250, Number(readEnv("PIRATE_TIMING_POLL_INTERVAL_MS", "2000")))
  const readyTimeoutMs = Math.max(1000, Number(readEnv("PIRATE_TIMING_READY_TIMEOUT_MS", "180000")))
  const outputPath = readFlag("--output") || readEnv("PIRATE_TIMING_OUTPUT")
  const expectedGitSha = readFlag("--expect-git-sha") || readEnv("PIRATE_TIMING_EXPECT_GIT_SHA")
  if (hasFlag("--skip-owner-access") && !isLocalApiUrl(apiBaseUrl) && !hasFlag("--allow-remote-skip-owner-access")) {
    throw new Error("--skip-owner-access is only allowed for localhost runs unless --allow-remote-skip-owner-access is set")
  }
  const events: TimingEvent[] = []
  const file = await readFixture(filePath, kind.startsWith("song-") ? "audio/mpeg" : "video/mp4")
  const posterFile = posterPath ? await readFixture(posterPath, "image/jpeg") : null
  const target = isLocalApiUrl(apiBaseUrl) ? "local" : "remote"
  const runPrefix = `timing_${kind}_${Date.now()}`
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, "", "utf8")
  }
  const recordEvent = (event: TimingEvent) => recordTimingEvent({
    event,
    events,
    outputPath,
  })

  console.log("[timing] config", {
    apiBaseUrl,
    communityId,
    kind,
    runs,
    warmupRuns,
    file: {
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.bytes.byteLength,
    },
    poster_file: posterFile
      ? {
          filename: posterFile.filename,
          mime_type: posterFile.mimeType,
          size_bytes: posterFile.bytes.byteLength,
        }
      : null,
    pollIntervalMs,
    readyTimeoutMs,
    expectedGitSha: expectedGitSha || null,
  })

  for (let index = 0; index < runs + warmupRuns; index += 1) {
    const runId = `${runPrefix}_${index + 1}`
    const summaryExcluded = index < warmupRuns
    try {
      if (expectedGitSha) {
        await assertApiVersion({
          apiBaseUrl,
          events,
          expectedGitSha,
          kind,
          outputPath,
          outputTarget: target,
          runId,
          runIndex: index + 1,
          stage: "api_version_before",
          summaryExcluded,
        })
      }
      await runOne({
        apiBaseUrl,
        communityId,
        events,
        file,
        kind,
        outputTarget: target,
        pollIntervalMs,
        posterFile,
        recordEvent,
        readyTimeoutMs,
        runId,
        runIndex: index + 1,
        summaryExcluded,
        skipVerification: hasFlag("--skip-verification"),
      })
      if (expectedGitSha) {
        await assertApiVersion({
          apiBaseUrl,
          events,
          expectedGitSha,
          kind,
          outputPath,
          outputTarget: target,
          runId,
          runIndex: index + 1,
          stage: "api_version_after",
          summaryExcluded,
        })
      }
    } catch (error) {
      console.error("[timing] run failed", {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (expectedGitSha) {
        throw error
      }
    }
  }

  if (outputPath) {
    console.log(`[timing] wrote ${outputPath}`)
  }
  summarize(events)
}

main().catch((error) => {
  console.error("[timing] failed", error)
  process.exit(1)
})
