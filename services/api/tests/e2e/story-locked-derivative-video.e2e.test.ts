import { describe, expect, test } from "bun:test"
import { SignJWT } from "jose"
import { Wallet } from "ethers"

type ApiInput = {
  body?: unknown
  bytes?: Uint8Array
  contentType?: string
  method: "GET" | "POST"
  ok?: number[]
  path: string
  token?: string | null
}

type Session = {
  accessToken: string
  userId: string
}

type Asset = {
  access_mode?: string | null
  id: string
  locked_delivery_error?: string | null
  locked_delivery_status?: string | null
  story_cdr_vault_uuid?: number | null
  story_derivative_parent_ip_ids?: string[] | null
  story_error?: string | null
  story_ip?: string | null
  story_license_terms?: string | null
  story_royalty_registration_status?: string | null
  story_status?: string | null
}

type DerivativeSource = {
  asset: string
  kind: string
  source_ref: string
  story_ip: string
  story_license_terms: string
  title?: string | null
}

const runLiveE2E = process.env.PIRATE_E2E_STORY_LOCKED_DERIVATIVE_VIDEO === "1"
const liveTest = runLiveE2E ? test : test.skip

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback
}

function requireEnv(name: string, fallback = ""): string {
  const value = env(name, fallback)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function apiBaseUrl(): string {
  return requireEnv("PIRATE_E2E_API_BASE_URL", "https://api-staging.pirate.sc").replace(/\/+$/u, "")
}

function communityId(): string {
  return requireEnv("PIRATE_E2E_COMMUNITY_ID").replace(/^com_/u, "")
}

function isStagingApiUrl(value: string): boolean {
  try {
    return new URL(value).hostname.includes("staging")
  } catch {
    return false
  }
}

function jwtConfig(baseUrl: string): { audience: string; issuer: string; secret: string } {
  const staging = isStagingApiUrl(baseUrl)
  return {
    issuer: env("AUTH_UPSTREAM_JWT_ISSUER", staging ? "pirate-staging-upstream" : ""),
    audience: env("AUTH_UPSTREAM_JWT_AUDIENCE", staging ? "pirate-api-staging" : ""),
    secret: requireEnv("AUTH_UPSTREAM_JWT_SHARED_SECRET", env("JWT_BASED_AUTH_SHARED_SECRET")),
  }
}

function normalizePrivateKey(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
  return /^0x[a-fA-F0-9]{64}$/u.test(prefixed) ? prefixed : null
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function logE2EStep(message: string, details?: Record<string, unknown>): void {
  console.info(`[story-locked-derivative-video-e2e] ${message}`, details ?? "")
}

async function api<T>(input: ApiInput): Promise<T> {
  const requestBody = input.bytes
    ? new Blob([bytesToArrayBuffer(input.bytes)], { type: input.contentType ?? "application/octet-stream" })
    : (input.body == null ? undefined : JSON.stringify(input.body))
  const response = await fetch(`${apiBaseUrl()}${input.path}`, {
    method: input.method,
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body == null ? {} : { "content-type": "application/json" }),
      ...(input.bytes == null ? {} : { "content-type": input.contentType ?? "application/octet-stream" }),
    },
    body: requestBody,
  })
  const body = await readJsonResponse(response)
  const ok = input.ok ?? [200, 201, 202]
  if (!ok.includes(response.status)) {
    throw new Error(`${input.method} ${input.path} failed with ${response.status}: ${JSON.stringify(body)}`)
  }
  return body as T
}

async function createSession(subject: string): Promise<Session> {
  const wallet = new Wallet(normalizePrivateKey(process.env.PIRATE_E2E_AUTHOR_PRIVATE_KEY) ?? Wallet.createRandom().privateKey)
  const config = jwtConfig(apiBaseUrl())
  const jwt = await new SignJWT({ wallet_address: wallet.address })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(config.secret))

  const body = await api<{
    access_token: string
    user: { id: string }
  }>({
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
  }
}

async function completeUniqueHuman(session: Session): Promise<void> {
  const created = await api<{ id: string }>({
    method: "POST",
    path: "/verification-sessions",
    token: session.accessToken,
    body: {
      provider: "self",
      requested_capabilities: ["unique_human", "age_over_18"],
    },
  })
  await api({
    method: "POST",
    path: `/verification-sessions/${encodeURIComponent(created.id)}/complete`,
    token: session.accessToken,
    body: {},
    ok: [200],
  })
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

async function uploadArtifact(input: {
  artifactKind: "primary_audio" | "primary_video"
  bytes: Uint8Array
  filename: string
  mimeType: string
  session: Session
}): Promise<{ id: string; storage_ref: string }> {
  const upload = await api<{ id: string; storage_ref: string }>({
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId())}/song-artifact-uploads`,
    token: input.session.accessToken,
    body: {
      artifact_kind: input.artifactKind,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
    },
  })
  await api({
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId())}/song-artifact-uploads/${encodeURIComponent(upload.id)}/content`,
    token: input.session.accessToken,
    bytes: input.bytes,
    contentType: "application/octet-stream",
  })
  return upload
}

async function createSongBundle(input: {
  session: Session
  title: string
}): Promise<string> {
  const upload = await uploadArtifact({
    artifactKind: "primary_audio",
    bytes: makeSilentWavBytes(),
    filename: "story-e2e-source.wav",
    mimeType: "audio/wav",
    session: input.session,
  })
  const bundle = await api<{ id: string }>({
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId())}/song-artifacts`,
    token: input.session.accessToken,
    body: {
      lyrics: "Story locked derivative video e2e lyric",
      primary_audio: {
        song_artifact_upload: upload.id,
      },
      preview_window: {
        start_ms: 0,
        duration_ms: 30_000,
      },
      title: input.title,
    },
  })
  return bundle.id
}

async function createOriginalSongPost(input: {
  bundle: string
  session: Session
  title: string
}): Promise<{ asset: string; post: string }> {
  const body = await api<{ asset?: string | null; id: string }>({
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId())}/posts`,
    token: input.session.accessToken,
    body: {
      access_mode: "public",
      commercial_rev_share_pct: 10,
      idempotency_key: `story-e2e-original-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      identity_mode: "public",
      license_preset: "commercial-remix",
      post_type: "song",
      rights_basis: "original",
      song_artifact_bundle: input.bundle,
      song_mode: "original",
      title: input.title,
    },
  })
  if (!body.asset) throw new Error(`original song post ${body.id} did not return an asset`)
  return { asset: body.asset, post: body.id }
}

async function createLockedDerivativeVideoPost(input: {
  session: Session
  sourceRef: string
  title: string
}): Promise<{ asset: string; post: string }> {
  const videoBytes = new TextEncoder().encode(`story locked derivative video e2e ${Date.now()}`)
  const video = await uploadArtifact({
    artifactKind: "primary_video",
    bytes: videoBytes,
    filename: "story-e2e-derivative-video.mp4",
    mimeType: "video/mp4",
    session: input.session,
  })
  const body = await api<{ asset?: string | null; id: string }>({
    method: "POST",
    path: `/communities/${encodeURIComponent(communityId())}/posts`,
    token: input.session.accessToken,
    body: {
      access_mode: "locked",
      idempotency_key: `story-e2e-derivative-video-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      identity_mode: "public",
      license_preset: "non-commercial",
      media_refs: [{
        mime_type: "video/mp4",
        poster_frame_ms: 0,
        poster_height: 720,
        poster_mime_type: "image/jpeg",
        poster_ref: "ipfs://story-locked-derivative-video-e2e-poster",
        poster_size_bytes: 1024,
        poster_width: 1280,
        size_bytes: videoBytes.byteLength,
        storage_ref: video.storage_ref,
      }],
      post_type: "video",
      rights_basis: "derivative",
      title: input.title,
      upstream_asset_refs: [input.sourceRef],
      visibility: "members_only",
    },
  })
  if (!body.asset) throw new Error(`derivative video post ${body.id} did not return an asset`)
  return { asset: body.asset, post: body.id }
}

async function readAsset(input: {
  asset: string
  session: Session
}): Promise<Asset> {
  return await api<Asset>({
    method: "GET",
    path: `/communities/${encodeURIComponent(communityId())}/assets/${encodeURIComponent(input.asset)}`,
    token: input.session.accessToken,
  })
}

async function waitForAsset(input: {
  asset: string
  label: string
  predicate: (asset: Asset) => boolean
  session: Session
}): Promise<Asset> {
  const timeoutMs = Number(env("PIRATE_E2E_ASSET_READY_TIMEOUT_MS", "420000"))
  const intervalMs = Number(env("PIRATE_E2E_ASSET_READY_INTERVAL_MS", "5000"))
  const startedAt = Date.now()
  let lastAsset: Asset | null = null
  let lastStatus = ""

  while (Date.now() - startedAt <= timeoutMs) {
    const asset = await readAsset({ asset: input.asset, session: input.session })
    lastAsset = asset
    const status = [
      `locked=${asset.locked_delivery_status ?? "unset"}`,
      `story=${asset.story_status ?? "unset"}`,
      `royalty=${asset.story_royalty_registration_status ?? "unset"}`,
    ].join(" ")
    if (status !== lastStatus) {
      logE2EStep(`${input.label} status`, { asset: asset.id, status })
      lastStatus = status
    }
    if (asset.locked_delivery_status === "failed" || asset.locked_delivery_error) {
      throw new Error(`${input.label} locked delivery failed: ${JSON.stringify(asset)}`)
    }
    if (asset.story_royalty_registration_status === "failed" || asset.story_error) {
      throw new Error(`${input.label} Story registration failed: ${JSON.stringify(asset)}`)
    }
    if (input.predicate(asset)) {
      return asset
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`${input.label} did not become ready within ${timeoutMs}ms: ${JSON.stringify(lastAsset)}`)
}

async function listDerivativeSongSources(input: {
  query: string
  session: Session
}): Promise<DerivativeSource[]> {
  const params = new URLSearchParams({
    kind: "song",
    q: input.query,
    scope: "global",
  })
  const body = await api<{ items?: DerivativeSource[] }>({
    method: "GET",
    path: `/communities/${encodeURIComponent(communityId())}/derivative-sources?${params.toString()}`,
    token: input.session.accessToken,
  })
  return body.items ?? []
}

describe("Story locked derivative video E2E", () => {
  liveTest("publishes a locked derivative video that references a Story song source", async () => {
    const runId = new Date().toISOString()
    const title = `Story Locked Derivative Video E2E ${runId}`
    logE2EStep("starting", {
      apiBaseUrl: apiBaseUrl(),
      communityId: communityId(),
      runId,
    })
    const session = await createSession(env("PIRATE_E2E_AUTHOR_SUBJECT", "android-staging-smoke-owner-20260517103926"))
    logE2EStep("created session", { userId: session.userId })
    await completeUniqueHuman(session)
    logE2EStep("completed unique human verification")

    const bundle = await createSongBundle({
      session,
      title: `${title} Source Song`,
    })
    logE2EStep("created source song bundle", { bundle })
    const originalPost = await createOriginalSongPost({
      bundle,
      session,
      title: `${title} Source Song`,
    })
    logE2EStep("created source song post", originalPost)
    const sourceAsset = await waitForAsset({
      asset: originalPost.asset,
      label: "source song",
      predicate: (asset) => asset.story_royalty_registration_status === "registered" && Boolean(asset.story_ip) && Boolean(asset.story_license_terms),
      session,
    })
    logE2EStep("source song ready", {
      asset: sourceAsset.id,
      storyIp: sourceAsset.story_ip,
      storyLicenseTerms: sourceAsset.story_license_terms,
    })

    expect(sourceAsset.story_ip).toMatch(/^0x[a-fA-F0-9]{40}$/u)
    expect(sourceAsset.story_license_terms).toBeTruthy()

    const sources = await listDerivativeSongSources({
      query: title,
      session,
    })
    logE2EStep("loaded derivative song sources", { count: sources.length })
    const source = sources.find((item) => item.asset === sourceAsset.id)
    expect(source).toBeTruthy()
    expect(source?.kind).toBe("song")
    expect(source?.story_ip).toBe(sourceAsset.story_ip)
    expect(source?.story_license_terms).toBe(sourceAsset.story_license_terms)
    expect(source?.source_ref).toBe(`story:ip:${sourceAsset.story_ip}#licenseTermsId=${sourceAsset.story_license_terms}`)

    const videoPost = await createLockedDerivativeVideoPost({
      session,
      sourceRef: source!.source_ref,
      title: `${title} Locked Derivative Video`,
    })
    logE2EStep("created locked derivative video post", videoPost)
    const videoAsset = await waitForAsset({
      asset: videoPost.asset,
      label: "locked derivative video",
      predicate: (asset) =>
        asset.locked_delivery_status === "ready"
        && asset.story_royalty_registration_status === "registered"
        && Boolean(asset.story_ip)
        && Boolean(asset.story_cdr_vault_uuid),
      session,
    })
    logE2EStep("locked derivative video ready", {
      asset: videoAsset.id,
      cdrVaultUuid: videoAsset.story_cdr_vault_uuid,
      parentIpIds: videoAsset.story_derivative_parent_ip_ids,
      storyIp: videoAsset.story_ip,
    })

    expect(videoAsset.access_mode).toBe("locked")
    expect(videoAsset.locked_delivery_status).toBe("ready")
    expect(videoAsset.story_status).toBe("published")
    expect(videoAsset.story_royalty_registration_status).toBe("registered")
    expect(videoAsset.story_ip).toMatch(/^0x[a-fA-F0-9]{40}$/u)
    expect(videoAsset.story_cdr_vault_uuid).toBeGreaterThan(0)
    expect(videoAsset.story_derivative_parent_ip_ids).toContain(sourceAsset.story_ip)
  }, 600_000)
})
