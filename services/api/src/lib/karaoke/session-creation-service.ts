import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  serializeKaraokeScoringPolicy,
  serializeKaraokeScoringPolicyForApi,
  type KaraokeScoringPolicy,
  type PublicKaraokeScoringPolicy,
  type ScorableKaraokeLine,
} from "@pirate-social-club/karaoke-runtime"
import type { SongKaraokePayload } from "@pirate/api-contracts"
import { HttpError } from "../errors"
import {
  KARAOKE_GATEWAY_TOKEN_TTL_SECONDS,
  KARAOKE_GATEWAY_TOKEN_VERSION,
  type KaraokeGatewayClaims,
} from "./gateway-token"
import type {
  ClaimKaraokeSessionCreationResult,
  KaraokeSessionCreationKey,
  KaraokeSessionCreationRecord,
  RotateKaraokeGatewayClaimsResult,
} from "./session-creation-repository"

const KARAOKE_SESSION_TTL_SECONDS = 3600 as const
const KARAOKE_CREATION_PENDING_TTL_SECONDS = 30
const KARAOKE_CREATION_FAILED_TTL_SECONDS = 60

type KaraokeSessionCreateErrorCode =
  | "karaoke_scoring_disabled"
  | "karaoke_unavailable"
  | "karaoke_stt_unconfigured"
  | "karaoke_runtime_unavailable"
  | "karaoke_runtime_initialization_failed"
  | "karaoke_session_create_in_progress"

export interface KaraokeSessionCreateResponse {
  id: string
  object: "karaoke_session"
  attempt: string
  protocol_version: typeof KARAOKE_TRANSPORT_PROTOCOL_VERSION
  websocket_url: string
  token_expires_at: number
  session_expires_at: number
  scoring_policy: PublicKaraokeScoringPolicy
}

export interface KaraokeSessionCreationDependencies {
  claim(input: {
    key: KaraokeSessionCreationKey
    now: string
    pendingExpiresAt: string
  }): Promise<ClaimKaraokeSessionCreationResult>
  fail(input: {
    key: KaraokeSessionCreationKey
    failureCode: string
    now: string
    expiresAt: string
  }): Promise<void>
  finalize(input: {
    key: KaraokeSessionCreationKey
    sessionId: string
    attemptId: string
    websocketBaseUrl: string
    protocolVersion: number
    scoringPolicyJson: string
    sessionExpiresAt: string
    tokenIssuedAt: number
    tokenExpiresAt: number
    tokenNonce: string
    now: string
  }): Promise<KaraokeSessionCreationRecord>
  initializeRuntime(input: {
    communityId: string
    postId: string
    sessionId: string
    attemptId: string
    subjectUserId: string
    sessionExpiresAtMs: number
    lines: ScorableKaraokeLine[]
    scoringPolicy: KaraokeScoringPolicy
  }): Promise<{ errorCode?: string | null; status: number }>
  issueToken(input: { claims: KaraokeGatewayClaims }): Promise<string>
  loadPayload(): Promise<SongKaraokePayload>
  randomUUID(): string
  resolveScoringPolicy(): Promise<KaraokeScoringPolicy>
  rotateClaims(input: {
    key: KaraokeSessionCreationKey
    previousTokenExpiresAt: number
    tokenIssuedAt: number
    tokenExpiresAt: number
    tokenNonce: string
    now: string
  }): Promise<RotateKaraokeGatewayClaimsResult>
  nowMs(): number
  websocketBaseUrl(sessionId: string): string
}

type InitializedCreationRecord = KaraokeSessionCreationRecord & {
  attemptId: string
  protocolVersion: typeof KARAOKE_TRANSPORT_PROTOCOL_VERSION
  scoringPolicyJson: string
  sessionExpiresAt: string
  sessionId: string
  tokenExpiresAt: number
  tokenIssuedAt: number
  tokenNonce: string
  websocketBaseUrl: string
}

function karaokeError(status: number, code: KaraokeSessionCreateErrorCode, message: string): HttpError {
  return new HttpError(status, code, message, status >= 500 || code === "karaoke_session_create_in_progress")
}

function cachedFailureError(failureCode: string | null): HttpError {
  if (failureCode === "karaoke_stt_unconfigured") {
    return karaokeError(400, "karaoke_stt_unconfigured", "Karaoke scoring provider is not configured")
  }
  if (failureCode === "karaoke_scoring_disabled" || failureCode === "karaoke_unavailable") {
    return karaokeError(409, failureCode, "Karaoke is unavailable")
  }
  const code = failureCode === "karaoke_runtime_initialization_failed"
    ? failureCode
    : "karaoke_runtime_unavailable"
  return karaokeError(503, code, "Karaoke runtime initialization failed")
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function requireInitializedRecord(record: KaraokeSessionCreationRecord): InitializedCreationRecord {
  if (
    !record.sessionId
    || !record.attemptId
    || !record.websocketBaseUrl
    || record.protocolVersion !== KARAOKE_TRANSPORT_PROTOCOL_VERSION
    || !record.scoringPolicyJson
    || !record.sessionExpiresAt
    || record.tokenIssuedAt === null
    || record.tokenExpiresAt === null
    || !record.tokenNonce
  ) {
    throw karaokeError(503, "karaoke_runtime_initialization_failed", "Stored karaoke session is incomplete")
  }
  return {
    ...record,
    attemptId: record.attemptId,
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    scoringPolicyJson: record.scoringPolicyJson,
    sessionExpiresAt: record.sessionExpiresAt,
    sessionId: record.sessionId,
    tokenExpiresAt: record.tokenExpiresAt,
    tokenIssuedAt: record.tokenIssuedAt,
    tokenNonce: record.tokenNonce,
    websocketBaseUrl: record.websocketBaseUrl,
  }
}

function parseStoredPolicy(json: string): KaraokeSessionCreateResponse["scoring_policy"] {
  try {
    const value = JSON.parse(json) as ReturnType<typeof serializeKaraokeScoringPolicy>
    if (!value || (value.kind !== "enabled" && value.kind !== "disabled")) throw new Error("invalid policy")
    return serializeKaraokeScoringPolicyForApi(value)
  } catch {
    throw karaokeError(503, "karaoke_runtime_initialization_failed", "Stored karaoke policy is invalid")
  }
}

function toScorableLines(payload: SongKaraokePayload): ScorableKaraokeLine[] {
  const source = payload.karaoke_lines?.filter((line) => line.kind === "lyric") ?? []
  const seen = new Set<string>()
  const lines = source.map((line, scoredLineIndex) => {
    if (!line.id || seen.has(line.id)) {
      throw karaokeError(409, "karaoke_unavailable", "Karaoke lyric lines have invalid identity")
    }
    seen.add(line.id)
    if (
      !Number.isSafeInteger(line.index)
      || line.index < 0
      || !Number.isFinite(line.start_ms)
      || !Number.isFinite(line.end_ms)
      || line.start_ms < 0
      || line.end_ms <= line.start_ms
    ) {
      throw karaokeError(409, "karaoke_unavailable", "Karaoke lyric lines have invalid timing")
    }
    return {
      endMs: line.end_ms,
      lineId: line.id,
      lineIndex: line.index,
      scoredLineIndex,
      startMs: line.start_ms,
      text: line.text,
      words: line.words
        .filter((word) => Number.isFinite(word.start_ms) && Number.isFinite(word.end_ms) && word.end_ms > word.start_ms)
        .map((word) => ({
          endMs: word.end_ms,
          startMs: word.start_ms,
          text: word.text,
        })),
    }
  })
  if (lines.length === 0) {
    throw karaokeError(409, "karaoke_unavailable", "Karaoke has no scorable lyric lines")
  }
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!
    const current = lines[index]!
    if (
      current.startMs < previous.startMs
      || (current.startMs === previous.startMs && current.endMs < previous.endMs)
      || current.scoredLineIndex !== index
    ) {
      throw karaokeError(409, "karaoke_unavailable", "Karaoke lyric lines are not stably ordered")
    }
  }
  return lines
}

function claimsFromRecord(record: InitializedCreationRecord): KaraokeGatewayClaims {
  return {
    attemptId: record.attemptId,
    communityId: record.communityId,
    expiresAt: record.tokenExpiresAt,
    issuedAt: record.tokenIssuedAt,
    nonce: record.tokenNonce,
    postId: record.postId,
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    sessionId: record.sessionId,
    subject: record.subjectUserId,
    tokenVersion: KARAOKE_GATEWAY_TOKEN_VERSION,
  }
}

async function responseFromRecord(input: {
  deps: KaraokeSessionCreationDependencies
  key: KaraokeSessionCreationKey
  record: KaraokeSessionCreationRecord
  nowMs: number
}): Promise<KaraokeSessionCreateResponse> {
  let record = requireInitializedRecord(input.record)
  const nowSeconds = Math.floor(input.nowMs / 1000)
  if (record.tokenExpiresAt <= nowSeconds) {
    const rotation = await input.deps.rotateClaims({
      key: input.key,
      now: iso(input.nowMs),
      previousTokenExpiresAt: record.tokenExpiresAt,
      tokenExpiresAt: nowSeconds + KARAOKE_GATEWAY_TOKEN_TTL_SECONDS,
      tokenIssuedAt: nowSeconds,
      tokenNonce: input.deps.randomUUID(),
    })
    record = requireInitializedRecord(rotation.record)
  }
  const token = await input.deps.issueToken({ claims: claimsFromRecord(record) })
  const websocketUrl = new URL(record.websocketBaseUrl)
  websocketUrl.searchParams.set("token", token)
  return {
    attempt: record.attemptId,
    id: record.sessionId,
    object: "karaoke_session",
    protocol_version: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    scoring_policy: parseStoredPolicy(record.scoringPolicyJson),
    session_expires_at: Math.floor(Date.parse(record.sessionExpiresAt) / 1000),
    token_expires_at: record.tokenExpiresAt,
    websocket_url: websocketUrl.toString(),
  }
}

export async function createKaraokeSession(input: {
  communityId: string
  deps: KaraokeSessionCreationDependencies
  idempotencyKey: string
  postId: string
  subjectUserId: string
}): Promise<KaraokeSessionCreateResponse> {
  const nowMs = input.deps.nowMs()
  const key: KaraokeSessionCreationKey = {
    communityId: input.communityId,
    idempotencyKey: input.idempotencyKey,
    postId: input.postId,
    subjectUserId: input.subjectUserId,
  }
  const claim = await input.deps.claim({
    key,
    now: iso(nowMs),
    pendingExpiresAt: iso(nowMs + KARAOKE_CREATION_PENDING_TTL_SECONDS * 1000),
  })
  if (claim.kind === "pending") {
    throw karaokeError(409, "karaoke_session_create_in_progress", "Karaoke session creation is already in progress")
  }
  if (claim.kind === "initialized") {
    return await responseFromRecord({ deps: input.deps, key, nowMs, record: claim.record })
  }
  if (claim.kind === "failed") {
    throw cachedFailureError(claim.record.failureCode)
  }

  let failureCode = "karaoke_runtime_initialization_failed"
  try {
    const payload = await input.deps.loadPayload()
    const lines = toScorableLines(payload)
    const scoringPolicy = await input.deps.resolveScoringPolicy()
    if (scoringPolicy.kind !== "enabled") {
      throw karaokeError(409, "karaoke_scoring_disabled", "Karaoke scoring is disabled")
    }

    const nowSeconds = Math.floor(nowMs / 1000)
    const sessionExpiresAtMs = nowMs + KARAOKE_SESSION_TTL_SECONDS * 1000
    const scoringPolicyJson = JSON.stringify(serializeKaraokeScoringPolicy(scoringPolicy))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = input.deps.randomUUID()
      const attemptId = input.deps.randomUUID()
      const tokenNonce = input.deps.randomUUID()
      const claims: KaraokeGatewayClaims = {
        attemptId,
        communityId: input.communityId,
        expiresAt: nowSeconds + KARAOKE_GATEWAY_TOKEN_TTL_SECONDS,
        issuedAt: nowSeconds,
        nonce: tokenNonce,
        postId: input.postId,
        protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
        sessionId,
        subject: input.subjectUserId,
        tokenVersion: KARAOKE_GATEWAY_TOKEN_VERSION,
      }
      await input.deps.issueToken({ claims })
      const runtime = await input.deps.initializeRuntime({
        attemptId,
        communityId: input.communityId,
        lines,
        postId: input.postId,
        scoringPolicy,
        sessionExpiresAtMs,
        sessionId,
        subjectUserId: input.subjectUserId,
      })
      if (runtime.errorCode?.startsWith("karaoke_stt_unconfigured_")) {
        failureCode = "karaoke_stt_unconfigured"
        throw karaokeError(400, "karaoke_stt_unconfigured", "Karaoke scoring provider is not configured")
      }
      if (runtime.status === 409 && attempt === 0) continue
      if (runtime.status !== 200) {
        failureCode = runtime.status === 409
          ? "karaoke_runtime_initialization_failed"
          : "karaoke_runtime_unavailable"
        throw karaokeError(503, failureCode as KaraokeSessionCreateErrorCode, "Karaoke runtime initialization failed")
      }

      const record = await input.deps.finalize({
        attemptId,
        key,
        now: iso(nowMs),
        protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
        scoringPolicyJson,
        sessionExpiresAt: iso(sessionExpiresAtMs),
        sessionId,
        tokenExpiresAt: claims.expiresAt,
        tokenIssuedAt: claims.issuedAt,
        tokenNonce,
        websocketBaseUrl: input.deps.websocketBaseUrl(sessionId),
      })
      return await responseFromRecord({ deps: input.deps, key, nowMs, record })
    }
    throw karaokeError(503, "karaoke_runtime_initialization_failed", "Karaoke runtime initialization failed")
  } catch (error) {
    if (error instanceof HttpError) failureCode = error.code
    await input.deps.fail({
      expiresAt: iso(nowMs + KARAOKE_CREATION_FAILED_TTL_SECONDS * 1000),
      failureCode,
      key,
      now: iso(nowMs),
    })
    throw error
  }
}
