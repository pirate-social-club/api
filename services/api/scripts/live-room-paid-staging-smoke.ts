import { spawnSync } from "node:child_process"
import { SignJWT } from "jose"
import { Interface, JsonRpcProvider, Wallet, getAddress } from "ethers"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

type SmokeSession = {
  accessToken: string
  userId: string
  walletAddress: string
  walletAttachment: string | null
  privateKey: string
}

type ApiResult<T = unknown> = {
  body: T
  status: number
}

type RuntimeAgoraBlock = {
  app_id: string | null
  channel: string
  configured: boolean
  token: string | null
  token_expires_at: number | null
  uid: number
}

type ReplayAccessMode = "free" | "included_with_ticket" | "paid"

const DEFAULT_STAGING_API_BASE_URL = "https://api-staging.pirate.sc"
const ERC20_INTERFACE = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
])

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1).trim()
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1]?.trim() || null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function usage(): void {
  console.log(`Usage:
  bun run scripts/live-room-paid-staging-smoke.ts [--settle-purchase]

Default mode creates a staging paid live room, verifies purchase_required access, host-attaches,
and creates a checkout quote without sending funds.

Flags:
  --settle-purchase      Send Base Sepolia USDC, settle the quote, and verify viewer_attach.
  --recording-enabled    Create the room with recording enabled and verify recording draft processing after host attach.
  --replay-access-mode <free|included_with_ticket|paid>
                         End the recorded room, wait for Filebase ingest, publish the replay, and verify replay access.
  --skip-verification    Skip self verification for newly created smoke users.
  --keep-room-open       Do not end/cancel the smoke live room in cleanup.
  --api-base-url <url>   Override PIRATE_SMOKE_API_BASE_URL.
  --price-cents <n>      Override PIRATE_SMOKE_PRICE_CENTS, default 199.
  --replay-price-cents <n>
                         Override paid replay price, default PIRATE_SMOKE_REPLAY_PRICE_CENTS or --price-cents.
  --recording-hold-ms <n>
                         When publishing a replay, wait this long after host attach before ending; default 20000.
  --community-id <id>    Reuse an existing provisioned community instead of creating a new one.
                         Can also be set with PIRATE_SMOKE_COMMUNITY_ID.
  --require-existing-community
                         Fail before creating smoke users or communities unless --community-id/PIRATE_SMOKE_COMMUNITY_ID is set.
  --skip-remote-config-preflight
                         Skip the staging Worker secret-name preflight for replay recording runs.
  --host-subject <sub>   Stable upstream auth subject for the host. Can also be set with PIRATE_SMOKE_HOST_SUBJECT.
  --buyer-subject <sub>  Stable upstream auth subject for the buyer. Can also be set with PIRATE_SMOKE_BUYER_SUBJECT.

Required env for staging:
  AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET
  AGORA_APP_ID and AGORA_APP_CERTIFICATE configured in the API environment

Required env for --settle-purchase:
  PIRATE_CHECKOUT_RPC_URL
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS
  PIRATE_CHECKOUT_SMOKE_BUYER_PRIVATE_KEY, PIRATE_SMOKE_BUYER_PRIVATE_KEY, or PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY

Required staging Worker secrets for --recording-enabled --replay-access-mode:
  AGORA_CLOUD_RECORDING_CUSTOMER_ID
  AGORA_CLOUD_RECORDING_CUSTOMER_SECRET
  STORY_COMPOSITE_READ_CONDITION_ADDRESS
`)
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "")
}

function normalizePrivateKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const prefixed = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
  return /^0x[a-fA-F0-9]{64}$/u.test(prefixed) ? prefixed : null
}

function readEnv(env: Record<string, string | undefined>, name: string, fallback = ""): string {
  const cli = readArg(`--${name.toLowerCase().replaceAll("_", "-")}`)
  if (cli) return cli
  return env[name]?.trim() || fallback
}

function readPositiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function readReplayAccessMode(): ReplayAccessMode | null {
  const value = readArg("--replay-access-mode")
  if (!value) return null
  if (value === "free" || value === "included_with_ticket" || value === "paid") {
    return value
  }
  throw new Error("--replay-access-mode must be free, included_with_ticket, or paid")
}

function isStagingApiUrl(apiBaseUrl: string): boolean {
  try {
    return new URL(apiBaseUrl).hostname.includes("staging")
  } catch {
    return false
  }
}

function resolveJwtConfig(env: Record<string, string | undefined>, apiBaseUrl: string): {
  audience: string
  issuer: string
  secret: string
} {
  const staging = isStagingApiUrl(apiBaseUrl)
  const explicitIssuer = process.env.AUTH_UPSTREAM_JWT_ISSUER?.trim()
    || process.env.JWT_BASED_AUTH_ISSUERS?.split(",")[0]?.trim()
  const explicitAudience = process.env.AUTH_UPSTREAM_JWT_AUDIENCE?.trim()
    || process.env.JWT_BASED_AUTH_AUDIENCE?.trim()
  const explicitSecret = process.env.AUTH_UPSTREAM_JWT_SHARED_SECRET?.trim()
    || process.env.JWT_BASED_AUTH_SHARED_SECRET?.trim()

  const issuer = explicitIssuer
    || (staging ? "pirate-staging-upstream" : (env.AUTH_UPSTREAM_JWT_ISSUER || env.JWT_BASED_AUTH_ISSUERS || "pirate-dev").split(",")[0]!.trim())
  const audience = explicitAudience
    || (staging ? "pirate-api-staging" : env.AUTH_UPSTREAM_JWT_AUDIENCE || env.JWT_BASED_AUTH_AUDIENCE || "pirate-api")
  const secret = explicitSecret
    || (staging ? "" : env.AUTH_UPSTREAM_JWT_SHARED_SECRET || env.JWT_BASED_AUTH_SHARED_SECRET || "")

  if (!secret) {
    throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET is required")
  }

  return { audience, issuer, secret }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function internalUserId(userId: string): string {
  return userId.replace(/^usr_usr_/u, "usr_")
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

function resolveCheckoutOperatorAddress(env: Record<string, string | undefined>): string {
  const explicit = env.PIRATE_CHECKOUT_OPERATOR_ADDRESS?.trim()
  if (explicit) return getAddress(explicit)
  const operatorPrivateKey = normalizePrivateKey(env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY)
  if (!operatorPrivateKey) {
    throw new Error("PIRATE_CHECKOUT_OPERATOR_ADDRESS or PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY is required")
  }
  return getAddress(new Wallet(operatorPrivateKey).address)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const REQUIRED_STAGING_REPLAY_WORKER_SECRETS = [
  "AGORA_CLOUD_RECORDING_CUSTOMER_ID",
  "AGORA_CLOUD_RECORDING_CUSTOMER_SECRET",
  "STORY_COMPOSITE_READ_CONDITION_ADDRESS",
] as const

function assertStagingReplayWorkerSecretsPresent(input: {
  apiBaseUrl: string
  replayAccessMode: ReplayAccessMode | null
}): void {
  if (!input.replayAccessMode || !isStagingApiUrl(input.apiBaseUrl) || hasFlag("--skip-remote-config-preflight")) {
    return
  }

  const result = spawnSync("./node_modules/.bin/wrangler", [
    "secret",
    "list",
    "--env",
    "staging",
    "--format",
    "json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (result.status !== 0) {
    throw new Error(
      `Unable to preflight staging Worker secrets with wrangler secret list. `
      + `Authenticate Wrangler or pass --skip-remote-config-preflight to bypass this check.`
      + (stderr ? `\n${stderr}` : "")
      + (stdout ? `\n${stdout}` : ""),
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || "[]")
  } catch {
    throw new Error("wrangler secret list returned non-JSON output")
  }
  if (!Array.isArray(parsed)) {
    throw new Error("wrangler secret list returned an unexpected payload")
  }
  const names = new Set(parsed.map((item) => String((item as { name?: unknown }).name ?? "").trim()).filter(Boolean))
  const missing = REQUIRED_STAGING_REPLAY_WORKER_SECRETS.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(
      "Staging Worker is missing required replay recording secrets:\n"
      + missing.map((name) => `- ${name}`).join("\n")
      + "\nSet them in Infisical staging /services/api, sync to the Worker, then rerun the smoke.",
    )
  }
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
    body: body as T,
    status: response.status,
  }
}

async function apiResult<T>(input: {
  apiBaseUrl: string
  body?: unknown
  method?: string
  path: string
  token?: string | null
}): Promise<ApiResult<T>> {
  const method = input.method ?? (input.body == null ? "GET" : "POST")
  const timeoutMs = readPositiveInteger(readArg("--request-timeout-ms") || "60000", "request timeout")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${input.apiBaseUrl}${input.path}`, {
      body: input.body == null ? undefined : JSON.stringify(input.body),
      headers: {
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(input.body == null ? {} : { "content-type": "application/json" }),
      },
      method,
      signal: controller.signal,
    })
    return await readResponse<T>(response)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${method} ${input.path} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function api<T>(input: {
  apiBaseUrl: string
  body?: unknown
  method?: string
  ok?: number[]
  path: string
  token?: string | null
}): Promise<T> {
  const result = await apiResult<T>(input)
  const ok = input.ok ?? [200, 201, 202]
  if (!ok.includes(result.status)) {
    throw new Error(`${input.method ?? "GET"} ${input.path} failed with ${result.status}: ${JSON.stringify(result.body)}`)
  }
  return result.body
}

async function mintUpstreamJwt(input: {
  apiBaseUrl: string
  env: Record<string, string | undefined>
  subject: string
  walletAddress: string
}): Promise<string> {
  const jwt = resolveJwtConfig(input.env, input.apiBaseUrl)
  return await new SignJWT({ wallet_address: input.walletAddress })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(jwt.issuer)
    .setAudience(jwt.audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(jwt.secret))
}

async function createSession(input: {
  apiBaseUrl: string
  env: Record<string, string | undefined>
  privateKey?: string | null
  subject: string
}): Promise<SmokeSession> {
  const normalizedPrivateKey = normalizePrivateKey(input.privateKey)
  const wallet = normalizedPrivateKey ? new Wallet(normalizedPrivateKey) : Wallet.createRandom()
  const jwt = await mintUpstreamJwt({
    apiBaseUrl: input.apiBaseUrl,
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
    body: {
      proof: {
        jwt,
        type: "jwt_based_auth",
      },
    },
    method: "POST",
    path: "/auth/session/exchange",
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
  session: SmokeSession
}): Promise<void> {
  const created = await api<{ id: string; status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      provider: "self",
      requested_capabilities: ["unique_human", "age_over_18"],
    },
    method: "POST",
    path: "/verification-sessions",
    token: input.session.accessToken,
  })
  const completed = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {},
    method: "POST",
    path: `/verification-sessions/${encodeURIComponent(created.id)}/complete`,
    token: input.session.accessToken,
  })
  console.log("[paid-live-smoke] verification", {
    completed: completed.status,
    started: created.status,
    user: input.session.userId,
  })
}

async function createCommunity(input: {
  apiBaseUrl: string
  host: SmokeSession
  runId: string
}): Promise<string> {
  const created = await api<{
    community: { id: string; provisioning_state?: string | null }
    job: { id: string; status: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      display_name: `Paid Live Smoke ${input.runId}`,
      handle_policy: {
        policy_template: "standard",
      },
      membership_mode: "request",
    },
    method: "POST",
    path: "/communities",
    token: input.host.accessToken,
  })

  if (created.job.status !== "succeeded") {
    await waitForJob({
      apiBaseUrl: input.apiBaseUrl,
      jobId: created.job.id,
      token: input.host.accessToken,
    })
  }

  console.log("[paid-live-smoke] community", {
    community: created.community.id,
    job: created.job.id,
    provisioning_state: created.community.provisioning_state ?? null,
  })
  return created.community.id.replace(/^com_/u, "")
}

async function waitForJob(input: {
  apiBaseUrl: string
  jobId: string
  token: string
}): Promise<void> {
  const timeoutMs = readPositiveInteger(readArg("--job-timeout-ms") || "120000", "job timeout")
  const intervalMs = readPositiveInteger(readArg("--job-interval-ms") || "3000", "job interval")
  const startedAt = Date.now()
  let lastStatus = "unknown"

  while (Date.now() - startedAt <= timeoutMs) {
    const job = await api<{ id: string; status: string; error_code?: string | null }>({
      apiBaseUrl: input.apiBaseUrl,
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

async function approveBuyerMembership(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  host: SmokeSession
}): Promise<void> {
  const join = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      note: "Paid live room smoke buyer",
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/join`,
    token: input.buyer.accessToken,
  })
  if (join.status === "joined") {
    console.log("[paid-live-smoke] buyer membership", { status: "joined" })
    return
  }
  assert(join.status === "requested", `buyer join returned unexpected status ${join.status}`)

  const requests = await api<{
    items: Array<{ applicant_user: string; id: string; status: string }>
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/membership-requests?limit=25`,
    token: input.host.accessToken,
  })
  const request = requests.items.find((item) => item.applicant_user === input.buyer.userId && item.status === "pending")
    ?? requests.items.find((item) => item.status === "pending")
  assert(request, `pending buyer membership request not found: ${JSON.stringify(requests.items)}`)

  const approved = await api<{ status: string }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/membership-requests/${encodeURIComponent(request.id)}/approve`,
    token: input.host.accessToken,
  })
  assert(approved.status === "approved", `membership approval returned ${approved.status}`)
  console.log("[paid-live-smoke] buyer membership", {
    request: request.id,
    status: approved.status,
  })
}

async function publishPaidLiveRoom(input: {
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  priceCents: number
  recordingEnabled: boolean
  runId: string
}): Promise<{ listingId: string; postId: string; roomId: string }> {
  const published = await api<{
    listing: { id: string; live_room: string | null; price_cents: number }
    room: { anchor_post: string; id: string; recording_enabled?: boolean | null; replay_status?: string | null; status: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      listing: {
        price_cents: input.priceCents,
        regional_pricing_enabled: false,
        status: "active",
      },
      room: {
        access_mode: "paid",
        performer_allocations: [
          {
            role: "host",
            share_bps: 10000,
            user: internalUserId(input.host.userId),
          },
        ],
        recording_enabled: input.recordingEnabled,
        room_kind: "solo",
        setlist: {
          items: [
            {
              artist: "Pirate Smoke",
              rights_basis: "original",
              rights_status: "ready",
              title: `Paid Smoke Set ${input.runId}`,
            },
          ],
          status: "ready",
        },
        title: `Paid Live Smoke ${input.runId}`,
        visibility: "public",
      },
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/publish`,
    token: input.host.accessToken,
  })

  assert(published.listing.live_room === published.room.id, "listing is not linked to the published live room")
  assert(published.listing.price_cents === input.priceCents, "listing price did not round-trip")
  if (input.recordingEnabled) {
    assert(published.room.recording_enabled === true, `recording_enabled did not round-trip true: ${published.room.recording_enabled}`)
    assert(published.room.replay_status === "none", `new recording-enabled room should start with replay_status none, got ${published.room.replay_status}`)
  }
  console.log("[paid-live-smoke] paid room", {
    anchor_post: published.room.anchor_post,
    listing: published.listing.id,
    recording_enabled: published.room.recording_enabled ?? null,
    replay_status: published.room.replay_status ?? null,
    room: published.room.id,
    status: published.room.status,
  })
  return {
    listingId: published.listing.id,
    postId: published.room.anchor_post,
    roomId: published.room.id,
  }
}

async function assertAccessRequiresPurchase(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  listingId: string
  roomId: string
}): Promise<void> {
  const access = await api<{
    access: { allowed: boolean; decision_reason: string | null; listing: string | null }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/access`,
    token: input.buyer.accessToken,
  })
  assert(access.access.allowed === false, "buyer was unexpectedly allowed before purchase")
  assert(access.access.decision_reason === "purchase_required", `expected purchase_required, got ${access.access.decision_reason}`)
  assert(access.access.listing === input.listingId, "purchase_required response did not include the live-room listing")

  const attach = await apiResult({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/viewer_attach`,
    token: input.buyer.accessToken,
  })
  assert(attach.status === 402, `viewer_attach before purchase should return 402, got ${attach.status}: ${JSON.stringify(attach.body)}`)
  console.log("[paid-live-smoke] pre-purchase gate", {
    listing: access.access.listing,
    viewer_attach_status: attach.status,
  })
}

function assertAgora(label: string, agora: RuntimeAgoraBlock): void {
  assert(agora.configured === true, `${label} Agora block is not configured`)
  assert(typeof agora.app_id === "string" && agora.app_id.length > 0, `${label} Agora app_id is missing`)
  assert(/^pirate-live-/u.test(agora.channel), `${label} Agora channel is unexpected: ${agora.channel}`)
  assert(typeof agora.token === "string" && agora.token.startsWith("007"), `${label} Agora token is missing or not v3`)
  assert(typeof agora.token_expires_at === "number" && agora.token_expires_at > Math.floor(Date.now() / 1000), `${label} Agora token expiry is invalid`)
  assert(Number.isSafeInteger(agora.uid) && agora.uid >= 0, `${label} Agora uid is invalid`)
}

async function hostAttach(input: {
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  roomId: string
}): Promise<RuntimeAgoraBlock> {
  const attached = await api<{
    agora: RuntimeAgoraBlock
    runtime: { seat: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/host_attach`,
    token: input.host.accessToken,
  })
  assert(attached.runtime.seat === "host", `host_attach returned seat ${attached.runtime.seat}`)
  assertAgora("host", attached.agora)
  console.log("[paid-live-smoke] host attach", {
    channel: attached.agora.channel,
    expires_at: attached.agora.token_expires_at,
    uid: attached.agora.uid,
  })
  return attached.agora
}

async function assertRecordingDraftProcessing(input: {
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  roomId: string
}): Promise<void> {
  const draft = await api<{
    live_room: string
    object: string
    recording: null | {
      provider: string
      status: string
      raw_artifact: unknown
    }
    recording_enabled: boolean
    replay_asset: unknown
    replay_status: string
    status: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/recording-draft`,
    token: input.host.accessToken,
  })

  assert(draft.object === "live_room_replay_draft", `unexpected draft object ${draft.object}`)
  assert(draft.live_room === input.roomId, "recording draft live_room mismatch")
  assert(draft.recording_enabled === true, "recording draft did not report recording_enabled true")
  assert(draft.replay_status === "none" || draft.replay_status === "processing", `unexpected early replay_status ${draft.replay_status}`)
  assert(draft.status === "processing", `recording draft should be processing after host attach, got ${draft.status}`)
  assert(draft.replay_asset == null, "recording draft unexpectedly has a replay asset before ingest")
  assert(draft.recording?.provider === "agora", `recording provider mismatch: ${draft.recording?.provider}`)
  assert(["starting", "recording", "stopping", "captured", "ingesting"].includes(draft.recording.status), `unexpected recording status ${draft.recording.status}`)
  assert(draft.recording.raw_artifact == null, "recording draft unexpectedly has a raw artifact before room end")
  console.log("[paid-live-smoke] recording draft", {
    recording_status: draft.recording.status,
    replay_status: draft.replay_status,
    status: draft.status,
  })
}

async function holdRecordingWindowIfNeeded(input: {
  replayAccessMode: ReplayAccessMode | null
}): Promise<void> {
  if (!input.replayAccessMode) return
  const holdMs = readPositiveInteger(readArg("--recording-hold-ms") || "20000", "recording hold ms")
  console.log("[paid-live-smoke] recording hold", {
    hold_ms: holdMs,
  })
  await sleep(holdMs)
}

async function createPurchaseQuote(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  env: Record<string, string | undefined>
  listingId: string
  roomId: string
}): Promise<{
  final_price_cents: number
  funding_destination_address?: string | null
  id: string
  settlement_mode: string
}> {
  const chainId = resolveCheckoutSourceChainId(input.env)
  const quote = await api<{
    asset: string | null
    final_price_cents: number
    funding_destination_address?: string | null
    id: string
    live_room: string | null
    settlement_mode: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      client_estimated_hop_count: 1,
      client_estimated_slippage_bps: 0,
      funding_asset: {
        asset_symbol: "USDC",
        chain_id: chainId,
        chain_namespace: "eip155",
        display_name: `USDC on ${resolveCheckoutChainName(chainId)}`,
      },
      listing: input.listingId,
      route_provider: "pirate_checkout",
      source_chain: {
        chain_id: chainId,
        chain_namespace: "eip155",
        display_name: resolveCheckoutChainName(chainId),
      },
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/purchase-quotes`,
    token: input.buyer.accessToken,
  })

  assert(quote.asset == null, "live-room ticket quote unexpectedly included an asset")
  assert(quote.live_room === input.roomId, `quote live_room mismatch: ${quote.live_room}`)
  assert(quote.settlement_mode === "delivery_only_story_settlement", `unexpected settlement mode ${quote.settlement_mode}`)
  console.log("[paid-live-smoke] purchase quote", {
    final_price_cents: quote.final_price_cents,
    funding_destination_address: quote.funding_destination_address ?? null,
    quote: quote.id,
    settlement_mode: quote.settlement_mode,
  })
  return quote
}

async function sendCheckoutFunding(input: {
  buyer: SmokeSession
  env: Record<string, string | undefined>
  quote: {
    final_price_cents: number
    funding_destination_address?: string | null
  }
}): Promise<string> {
  const rpcUrl = input.env.PIRATE_CHECKOUT_RPC_URL?.trim()
  const usdc = input.env.PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS?.trim()
  if (!rpcUrl) throw new Error("PIRATE_CHECKOUT_RPC_URL is required for --settle-purchase")
  if (!usdc) throw new Error("PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS is required for --settle-purchase")
  if (!Number.isSafeInteger(input.quote.final_price_cents) || input.quote.final_price_cents <= 0) {
    throw new Error("quote final_price_cents is invalid")
  }

  const destination = getAddress(input.quote.funding_destination_address || resolveCheckoutOperatorAddress(input.env))
  const amountAtomic = BigInt(input.quote.final_price_cents) * 10_000n
  const provider = new JsonRpcProvider(rpcUrl, resolveCheckoutSourceChainId(input.env))
  const wallet = new Wallet(input.buyer.privateKey, provider)
  const tx = await wallet.sendTransaction({
    data: ERC20_INTERFACE.encodeFunctionData("transfer", [destination, amountAtomic]),
    to: getAddress(usdc),
  })
  console.log("[paid-live-smoke] checkout funding", {
    amount_usdc_atomic: amountAtomic.toString(),
    from: wallet.address,
    to: destination,
    tx: tx.hash,
  })
  const receipt = await tx.wait(1)
  if (!receipt || receipt.status !== 1) {
    throw new Error(`checkout funding transaction failed: ${tx.hash}`)
  }
  return tx.hash
}

async function settlePurchase(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  fundingTxRef: string
  quoteId: string
  roomId: string
}): Promise<string> {
  if (!input.buyer.walletAttachment) {
    throw new Error("buyer wallet attachment is required for purchase settlement")
  }
  const settlement = await api<{
    asset: string | null
    entitlement_kind: string
    entitlement_target_ref: string
    id: string
    live_room: string | null
    purchase_entitlement: string
    settlement_mode: string
    settlement_tx_ref: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      funding_tx_ref: input.fundingTxRef,
      quote: input.quoteId,
      settlement_tx_ref: readArg("--settlement-tx-ref") || input.fundingTxRef,
      settlement_wallet_attachment: input.buyer.walletAttachment,
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/purchase-settlements`,
    token: input.buyer.accessToken,
  })

  assert(settlement.asset == null, "live-room ticket settlement unexpectedly included an asset")
  assert(settlement.live_room === input.roomId, `settlement live_room mismatch: ${settlement.live_room}`)
  assert(settlement.entitlement_kind === "live_room_access", `unexpected entitlement kind ${settlement.entitlement_kind}`)
  assert(settlement.entitlement_target_ref === input.roomId, "settlement entitlement target did not match room")
  assert(settlement.settlement_mode === "delivery_only_story_settlement", `unexpected settlement mode ${settlement.settlement_mode}`)
  console.log("[paid-live-smoke] purchase settlement", {
    entitlement: settlement.purchase_entitlement,
    settlement: settlement.id,
    settlement_tx_ref: settlement.settlement_tx_ref,
  })
  return settlement.purchase_entitlement
}

async function assertAccessAllowed(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  entitlementId: string
  roomId: string
}): Promise<void> {
  const access = await api<{
    access: { allowed: boolean; decision_reason: string | null; purchase_entitlement: string | null }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/access`,
    token: input.buyer.accessToken,
  })
  assert(access.access.allowed === true, `buyer was not allowed after purchase: ${JSON.stringify(access.access)}`)
  assert(access.access.decision_reason == null, `unexpected post-purchase decision reason ${access.access.decision_reason}`)
  assert(access.access.purchase_entitlement === input.entitlementId, "post-purchase access did not expose the purchase entitlement")
  console.log("[paid-live-smoke] post-purchase access", {
    allowed: access.access.allowed,
    entitlement: access.access.purchase_entitlement,
  })
}

async function viewerAttachAndRenew(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  expectedChannel: string
  roomId: string
}): Promise<void> {
  const attach = await api<{
    agora: RuntimeAgoraBlock
    runtime: { seat: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/viewer_attach`,
    token: input.buyer.accessToken,
  })
  assert(attach.runtime.seat === "viewer", `viewer_attach returned seat ${attach.runtime.seat}`)
  assertAgora("viewer", attach.agora)
  assert(attach.agora.channel === input.expectedChannel, "viewer channel did not match host channel")

  const renew = await api<{
    agora: RuntimeAgoraBlock
    runtime: { seat: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      uid: attach.agora.uid,
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/viewer_renew`,
    token: input.buyer.accessToken,
  })
  assert(renew.runtime.seat === "viewer", `viewer_renew returned seat ${renew.runtime.seat}`)
  assertAgora("viewer renew", renew.agora)
  assert(renew.agora.uid === attach.agora.uid, "viewer renew changed uid")
  assert(renew.agora.channel === attach.agora.channel, "viewer renew changed channel")
  console.log("[paid-live-smoke] viewer attach and renew", {
    channel: attach.agora.channel,
    renew_expires_at: renew.agora.token_expires_at,
    uid: attach.agora.uid,
  })
}

async function endRoomForReplay(input: {
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  roomId: string
}): Promise<void> {
  const ended = await api<{
    id: string
    replay_status?: string | null
    status: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/end`,
    token: input.host.accessToken,
  })
  assert(ended.id === input.roomId, "ended room id mismatch")
  assert(ended.status === "ended", `room did not end, got ${ended.status}`)
  assert(ended.replay_status === "processing" || ended.replay_status === "failed", `unexpected replay_status after end: ${ended.replay_status}`)
  console.log("[paid-live-smoke] room ended for replay", {
    replay_status: ended.replay_status ?? null,
    room: ended.id,
  })
}

async function waitForReplayDraftReady(input: {
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  roomId: string
}): Promise<{ replayAssetId: string }> {
  const timeoutMs = readPositiveInteger(readArg("--replay-timeout-ms") || "240000", "replay timeout")
  const intervalMs = readPositiveInteger(readArg("--replay-interval-ms") || "5000", "replay interval")
  const startedAt = Date.now()
  let lastStatus = "unknown"
  let lastRecordingStatus = "unknown"

  while (Date.now() - startedAt <= timeoutMs) {
    const draft = await api<{
      live_room: string
      recording: null | {
        provider: string
        status: string
        raw_artifact: null | {
          provider: string
          ipfs_cid: string
          mime_type: string
          size_bytes: number
        }
      }
      replay_asset: null | {
        id?: string
        replay_asset_id?: string
        access_mode: string
      }
      replay_status: string
      status: string
    }>({
      apiBaseUrl: input.apiBaseUrl,
      path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/replay-draft`,
      token: input.host.accessToken,
    })
    lastStatus = draft.status
    lastRecordingStatus = draft.recording?.status ?? "none"
    if (draft.status === "failed" || draft.replay_status === "failed" || draft.recording?.status === "failed") {
      throw new Error(`recording replay failed: ${JSON.stringify(draft)}`)
    }
    if (draft.status === "ready" && draft.replay_status === "review_pending" && draft.replay_asset && draft.recording?.raw_artifact) {
      const replayAssetId = draft.replay_asset.id ?? draft.replay_asset.replay_asset_id
      assert(replayAssetId, `ready replay draft did not expose replay asset id: ${JSON.stringify(draft.replay_asset)}`)
      assert(draft.recording.raw_artifact.provider === "filebase", `raw recording did not land on Filebase: ${draft.recording.raw_artifact.provider}`)
      assert(typeof draft.recording.raw_artifact.ipfs_cid === "string" && draft.recording.raw_artifact.ipfs_cid.length > 0, "raw Filebase artifact is missing ipfs_cid")
      console.log("[paid-live-smoke] replay draft ready", {
        ipfs_cid: draft.recording.raw_artifact.ipfs_cid,
        recording_status: draft.recording.status,
        replay_asset: replayAssetId,
        replay_status: draft.replay_status,
      })
      return { replayAssetId }
    }
    await sleep(intervalMs)
  }

  throw new Error(`replay draft did not become ready within ${timeoutMs}ms; last status ${lastStatus}, recording ${lastRecordingStatus}`)
}

async function updateReplayDraftAccessMode(input: {
  accessMode: ReplayAccessMode
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  roomId: string
}): Promise<void> {
  if (input.accessMode === "free") return
  const draft = await api<{
    replay_asset: null | { access_mode: string }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      access_mode: input.accessMode,
    },
    method: "PATCH",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/replay-draft`,
    token: input.host.accessToken,
  })
  assert(draft.replay_asset?.access_mode === input.accessMode, `replay draft access mode did not update: ${draft.replay_asset?.access_mode}`)
  console.log("[paid-live-smoke] replay draft access mode", {
    access_mode: draft.replay_asset.access_mode,
  })
}

async function publishReplayDraft(input: {
  accessMode: ReplayAccessMode
  apiBaseUrl: string
  communityId: string
  host: SmokeSession
  replayPriceCents: number
  roomId: string
}): Promise<{ replayAssetId: string; replayListingId: string | null }> {
  const published = await api<{
    replay_asset: null | {
      access_mode: string
      id?: string
      replay_asset_id?: string
      locked_delivery_status: string
      publication_status: string
    }
    replay_status: string
    status: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      access_mode: input.accessMode,
      listing: input.accessMode === "paid"
        ? {
          price_cents: input.replayPriceCents,
          regional_pricing_enabled: false,
          status: "active",
        }
        : null,
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/replay-draft/publish`,
    token: input.host.accessToken,
  })
  const replayAssetId = published.replay_asset?.id ?? published.replay_asset?.replay_asset_id
  assert(published.status === "published", `replay draft publish returned status ${published.status}`)
  assert(published.replay_status === "published", `replay_status after publish was ${published.replay_status}`)
  assert(replayAssetId, `published replay did not include replay asset: ${JSON.stringify(published.replay_asset)}`)
  assert(published.replay_asset?.access_mode === input.accessMode, `published replay access mode mismatch: ${published.replay_asset?.access_mode}`)
  if (input.accessMode !== "free") {
    assert(published.replay_asset.locked_delivery_status === "ready", `locked replay delivery was not ready: ${published.replay_asset.locked_delivery_status}`)
  }

  const room = await api<{
    replay_asset: string | null
    replay_asset_id?: string | null
    replay_listing: string | null
    replay_listing_id?: string | null
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}`,
    token: input.host.accessToken,
  })
  const replayListingId = room.replay_listing ?? room.replay_listing_id ?? null
  if (input.accessMode === "paid") {
    assert(replayListingId, "paid replay publish did not attach replay listing to the room")
  }
  console.log("[paid-live-smoke] replay published", {
    access_mode: input.accessMode,
    replay_asset: replayAssetId,
    replay_listing: replayListingId,
  })
  return { replayAssetId, replayListingId }
}

async function assertReplayAccess(input: {
  accessMode: ReplayAccessMode
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  expectEntitled: boolean
  replayAssetId: string
  replayListingId: string | null
  roomId: string
}): Promise<void> {
  const access = await api<{
    access_granted: boolean
    access_mode: string | null
    decision_reason: string
    delivery_kind: string | null
    replay_asset: string | null
    replay_listing: null | {
      id: string
      price_cents: number
      replay_asset: string | null
    }
    story_cdr_access: null | {
      access_scope: string
      ciphertext_ref: string
      vault_uuid: number
    }
  }>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/replay/access`,
    token: input.buyer.accessToken,
  })
  assert(access.replay_asset === input.replayAssetId, `replay access asset mismatch: ${access.replay_asset}`)
  assert(access.access_mode === input.accessMode, `replay access mode mismatch: ${access.access_mode}`)
  if (input.accessMode === "free") {
    assert(access.access_granted === true, `free replay was not granted: ${JSON.stringify(access)}`)
    assert(access.decision_reason === "free", `free replay decision mismatch: ${access.decision_reason}`)
    assert(access.delivery_kind === "primary_content_ref", `free replay delivery mismatch: ${access.delivery_kind}`)
  } else if (input.expectEntitled) {
    assert(access.access_granted === true, `entitled locked replay was not granted: ${JSON.stringify(access)}`)
    assert(access.decision_reason === "purchase_entitlement", `locked replay decision mismatch: ${access.decision_reason}`)
    assert(access.delivery_kind === "story_cdr_ref", `locked replay delivery mismatch: ${access.delivery_kind}`)
    assert(access.story_cdr_access?.access_scope === "asset.share", `locked replay CDR access scope mismatch: ${access.story_cdr_access?.access_scope}`)
  } else {
    assert(access.access_granted === false, `locked replay was unexpectedly granted: ${JSON.stringify(access)}`)
    assert(access.decision_reason === "purchase_required", `locked replay decision mismatch: ${access.decision_reason}`)
    if (input.accessMode === "paid") {
      assert(access.replay_listing?.id === input.replayListingId, `paid replay access did not expose listing ${input.replayListingId}: ${JSON.stringify(access.replay_listing)}`)
      assert(access.replay_listing.replay_asset === input.replayAssetId, "paid replay listing target mismatch")
    }
  }
  console.log("[paid-live-smoke] replay access", {
    access_granted: access.access_granted,
    access_mode: access.access_mode,
    decision_reason: access.decision_reason,
    delivery_kind: access.delivery_kind,
  })
}

async function createReplayPurchaseQuote(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  env: Record<string, string | undefined>
  listingId: string
  replayAssetId: string
}): Promise<{
  final_price_cents: number
  funding_destination_address?: string | null
  id: string
  settlement_mode: string
}> {
  const chainId = resolveCheckoutSourceChainId(input.env)
  const quote = await api<{
    final_price_cents: number
    funding_destination_address?: string | null
    id: string
    replay_asset: string | null
    settlement_mode: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      client_estimated_hop_count: 1,
      client_estimated_slippage_bps: 0,
      funding_asset: {
        asset_symbol: "USDC",
        chain_id: chainId,
        chain_namespace: "eip155",
        display_name: `USDC on ${resolveCheckoutChainName(chainId)}`,
      },
      listing: input.listingId,
      route_provider: "pirate_checkout",
      source_chain: {
        chain_id: chainId,
        chain_namespace: "eip155",
        display_name: resolveCheckoutChainName(chainId),
      },
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/purchase-quotes`,
    token: input.buyer.accessToken,
  })

  assert(quote.replay_asset === input.replayAssetId, `replay quote target mismatch: ${quote.replay_asset}`)
  assert(quote.settlement_mode === "delivery_only_story_settlement", `unexpected replay settlement mode ${quote.settlement_mode}`)
  console.log("[paid-live-smoke] replay purchase quote", {
    final_price_cents: quote.final_price_cents,
    funding_destination_address: quote.funding_destination_address ?? null,
    quote: quote.id,
  })
  return quote
}

async function settleReplayPurchase(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  fundingTxRef: string
  quoteId: string
  replayAssetId: string
}): Promise<string> {
  if (!input.buyer.walletAttachment) {
    throw new Error("buyer wallet attachment is required for replay purchase settlement")
  }
  const settlement = await api<{
    entitlement_kind: string
    entitlement_target_ref: string
    id: string
    purchase_entitlement: string
    replay_asset: string | null
    settlement_mode: string
    settlement_tx_ref: string
  }>({
    apiBaseUrl: input.apiBaseUrl,
    body: {
      funding_tx_ref: input.fundingTxRef,
      quote: input.quoteId,
      settlement_tx_ref: readArg("--replay-settlement-tx-ref") || input.fundingTxRef,
      settlement_wallet_attachment: input.buyer.walletAttachment,
    },
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/purchase-settlements`,
    token: input.buyer.accessToken,
  })

  assert(settlement.replay_asset === input.replayAssetId, `replay settlement target mismatch: ${settlement.replay_asset}`)
  assert(settlement.entitlement_kind === "replay_access", `unexpected replay entitlement kind ${settlement.entitlement_kind}`)
  assert(settlement.entitlement_target_ref === input.replayAssetId, "replay settlement entitlement target mismatch")
  assert(settlement.settlement_mode === "delivery_only_story_settlement", `unexpected replay settlement mode ${settlement.settlement_mode}`)
  console.log("[paid-live-smoke] replay purchase settlement", {
    entitlement: settlement.purchase_entitlement,
    settlement: settlement.id,
    settlement_tx_ref: settlement.settlement_tx_ref,
  })
  return settlement.purchase_entitlement
}

async function cleanupRoom(input: {
  apiBaseUrl: string
  communityId: string
  host: SmokeSession | null
  hostAttached: boolean
  roomId: string | null
}): Promise<void> {
  if (!input.host || !input.roomId || hasFlag("--keep-room-open")) return
  const action = input.hostAttached ? "end" : "cancel"
  const result = await apiResult({
    apiBaseUrl: input.apiBaseUrl,
    method: "POST",
    path: `/communities/${encodeURIComponent(input.communityId)}/live-rooms/${encodeURIComponent(input.roomId)}/${action}`,
    token: input.host.accessToken,
  })
  if (![200, 404, 409].includes(result.status)) {
    console.warn("[paid-live-smoke] cleanup failed", {
      action,
      body: result.body,
      status: result.status,
    })
    return
  }
  console.log("[paid-live-smoke] cleanup", {
    action,
    room: input.roomId,
    status: result.status,
  })
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage()
    return
  }

  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Record<string, string | undefined>
  const apiBaseUrl = normalizeApiBaseUrl(
    readArg("--api-base-url")
      || readEnv(env, "PIRATE_SMOKE_API_BASE_URL", DEFAULT_STAGING_API_BASE_URL),
  )
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`
  const existingCommunityId = readArg("--community-id") || readEnv(env, "PIRATE_SMOKE_COMMUNITY_ID") || ""
  const hostSubject = readArg("--host-subject")
    || readEnv(env, "PIRATE_SMOKE_HOST_SUBJECT")
    || `paid-live-smoke-host-${runId}`
  const buyerSubject = readArg("--buyer-subject")
    || readEnv(env, "PIRATE_SMOKE_BUYER_SUBJECT")
    || `paid-live-smoke-buyer-${runId}`
  const priceCents = readPositiveInteger(
    readArg("--price-cents") || readEnv(env, "PIRATE_SMOKE_PRICE_CENTS", "199"),
    "price cents",
  )
  const settle = hasFlag("--settle-purchase")
  const recordingEnabled = hasFlag("--recording-enabled")
  const replayAccessMode = readReplayAccessMode()
  const requireExistingCommunity = hasFlag("--require-existing-community")
  const replayPriceCents = readPositiveInteger(
    readArg("--replay-price-cents") || readEnv(env, "PIRATE_SMOKE_REPLAY_PRICE_CENTS", String(priceCents)),
    "replay price cents",
  )
  if (replayAccessMode && !recordingEnabled) {
    throw new Error("--replay-access-mode requires --recording-enabled")
  }
  if (requireExistingCommunity && !existingCommunityId) {
    throw new Error("--require-existing-community requires --community-id or PIRATE_SMOKE_COMMUNITY_ID")
  }
  assertStagingReplayWorkerSecretsPresent({
    apiBaseUrl,
    replayAccessMode,
  })
  const skipVerification = hasFlag("--skip-verification")
  let host: SmokeSession | null = null
  let communityId = ""
  let roomId: string | null = null
  let hostAttached = false

  try {
    console.log("[paid-live-smoke] start", {
      api_base_url: apiBaseUrl,
      price_cents: priceCents,
      replay_access_mode: replayAccessMode,
      replay_price_cents: replayAccessMode === "paid" ? replayPriceCents : null,
      recording_enabled: recordingEnabled,
      run_id: runId,
      settle_purchase: settle,
      using_existing_community: Boolean(existingCommunityId),
    })

    host = await createSession({
      apiBaseUrl,
      env,
      subject: hostSubject,
    })
    console.log("[paid-live-smoke] host", {
      user: host.userId,
      wallet: host.walletAddress,
      wallet_attachment: host.walletAttachment,
    })
    if (!skipVerification) {
      await completeUniqueHuman({ apiBaseUrl, session: host })
    }

    const buyerPrivateKey = readEnv(env, "PIRATE_CHECKOUT_SMOKE_BUYER_PRIVATE_KEY")
      || readEnv(env, "PIRATE_SMOKE_BUYER_PRIVATE_KEY")
      || env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY
      || null
    const buyer = await createSession({
      apiBaseUrl,
      env,
      privateKey: buyerPrivateKey,
      subject: buyerSubject,
    })
    console.log("[paid-live-smoke] buyer", {
      user: buyer.userId,
      wallet: buyer.walletAddress,
      wallet_attachment: buyer.walletAttachment,
    })
    if (!skipVerification) {
      await completeUniqueHuman({ apiBaseUrl, session: buyer })
    }

    if (existingCommunityId) {
      communityId = existingCommunityId.replace(/^com_/u, "")
      console.log("[paid-live-smoke] community", {
        community: communityId,
        reused: true,
      })
    } else {
      communityId = await createCommunity({ apiBaseUrl, host, runId })
    }
    await approveBuyerMembership({ apiBaseUrl, buyer, communityId, host })

    const published = await publishPaidLiveRoom({
      apiBaseUrl,
      communityId,
      host,
      priceCents,
      recordingEnabled,
      runId,
    })
    roomId = published.roomId

    await assertAccessRequiresPurchase({
      apiBaseUrl,
      buyer,
      communityId,
      listingId: published.listingId,
      roomId,
    })

    const hostAgora = await hostAttach({ apiBaseUrl, communityId, host, roomId })
    hostAttached = true
    if (recordingEnabled) {
      await assertRecordingDraftProcessing({
        apiBaseUrl,
        communityId,
        host,
        roomId,
      })
    }
    await holdRecordingWindowIfNeeded({ replayAccessMode })

    const quote = await createPurchaseQuote({
      apiBaseUrl,
      buyer,
      communityId,
      env,
      listingId: published.listingId,
      roomId,
    })

    if (!settle && !replayAccessMode) {
      console.log("[paid-live-smoke] quote-only mode complete", {
        anchor_post: published.postId,
        community: communityId,
        listing: published.listingId,
        quote: quote.id,
        room: roomId,
      })
      console.log("[paid-live-smoke] rerun with --settle-purchase to send Base Sepolia USDC and verify entitlement + viewer_attach")
      return
    }

    if (settle) {
      const fundingTxRef = readArg("--funding-tx-ref")
        || readEnv(env, "PIRATE_SMOKE_FUNDING_TX_REF")
        || await sendCheckoutFunding({ buyer, env, quote })
      const entitlement = await settlePurchase({
        apiBaseUrl,
        buyer,
        communityId,
        fundingTxRef,
        quoteId: quote.id,
        roomId,
      })
      await assertAccessAllowed({
        apiBaseUrl,
        buyer,
        communityId,
        entitlementId: entitlement,
        roomId,
      })
      await viewerAttachAndRenew({
        apiBaseUrl,
        buyer,
        communityId,
        expectedChannel: hostAgora.channel,
        roomId,
      })
    } else {
      console.log("[paid-live-smoke] live-ticket quote-only mode", {
        quote: quote.id,
      })
    }

    if (replayAccessMode) {
      await endRoomForReplay({ apiBaseUrl, communityId, host, roomId })
      await waitForReplayDraftReady({ apiBaseUrl, communityId, host, roomId })
      await updateReplayDraftAccessMode({
        accessMode: replayAccessMode,
        apiBaseUrl,
        communityId,
        host,
        roomId,
      })
      const replay = await publishReplayDraft({
        accessMode: replayAccessMode,
        apiBaseUrl,
        communityId,
        host,
        replayPriceCents,
        roomId,
      })
      await assertReplayAccess({
        accessMode: replayAccessMode,
        apiBaseUrl,
        buyer,
        communityId,
        expectEntitled: settle && replayAccessMode === "included_with_ticket",
        replayAssetId: replay.replayAssetId,
        replayListingId: replay.replayListingId,
        roomId,
      })
      if (replayAccessMode === "paid") {
        assert(replay.replayListingId, "paid replay listing was missing")
        const replayQuote = await createReplayPurchaseQuote({
          apiBaseUrl,
          buyer,
          communityId,
          env,
          listingId: replay.replayListingId,
          replayAssetId: replay.replayAssetId,
        })
        if (settle) {
          const replayFundingTxRef = readArg("--replay-funding-tx-ref")
            || readEnv(env, "PIRATE_SMOKE_REPLAY_FUNDING_TX_REF")
            || await sendCheckoutFunding({ buyer, env, quote: replayQuote })
          await settleReplayPurchase({
            apiBaseUrl,
            buyer,
            communityId,
            fundingTxRef: replayFundingTxRef,
            quoteId: replayQuote.id,
            replayAssetId: replay.replayAssetId,
          })
          await assertReplayAccess({
            accessMode: replayAccessMode,
            apiBaseUrl,
            buyer,
            communityId,
            expectEntitled: true,
            replayAssetId: replay.replayAssetId,
            replayListingId: replay.replayListingId,
            roomId,
          })
        } else {
          console.log("[paid-live-smoke] paid replay quote-only mode", {
            quote: replayQuote.id,
            replay_asset: replay.replayAssetId,
            replay_listing: replay.replayListingId,
          })
        }
      }
    }

    console.log("[paid-live-smoke] paid live-room Base Sepolia smoke passed", {
      anchor_post: published.postId,
      community: communityId,
      listing: published.listingId,
      replay_access_mode: replayAccessMode,
      room: roomId,
    })
  } finally {
    if (communityId) {
      await cleanupRoom({
        apiBaseUrl,
        communityId,
        host,
        hostAttached,
        roomId,
      }).catch((error) => {
        console.warn("[paid-live-smoke] cleanup threw", error)
      })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
