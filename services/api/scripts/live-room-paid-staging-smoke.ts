import { spawnSync } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SignJWT } from "jose"
import { Wallet } from "ethers"
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


const DEFAULT_STAGING_API_BASE_URL = "https://api-staging.pirate.sc"
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
  bun run scripts/live-room-paid-staging-smoke.ts

Creates a staging paid live room, verifies purchase_required access, host-attaches, and asserts
that paid ticket checkout fails closed (403) — recipient payout execution for non-asset targets is
not implemented, so the API must reject the quote rather than issue an unpayable checkout. Sending
funds, settling, and paid/replay purchase are intentionally not exercised because that flow is
disabled; replay publish/access is covered by the community-live-room-routes route tests.

Flags:
  --recording-enabled    Create the room with recording enabled and verify recording draft processing after host attach.
  --skip-verification    Skip self verification for newly created smoke users.
  --keep-room-open       Do not end/cancel the smoke live room in cleanup.
  --api-base-url <url>   Override PIRATE_SMOKE_API_BASE_URL.
  --price-cents <n>      Override PIRATE_SMOKE_PRICE_CENTS, default 199.
  --publish-browser-media
                         Launch agent-browser with fake mic/camera media into the Agora channel during the smoke.
  --skip-browser-media-cleanup
                         Leave the browser session open after the smoke for debugging.
  --community-id <id>    Reuse an existing provisioned community instead of creating a new one.
                         Can also be set with PIRATE_SMOKE_COMMUNITY_ID.
  --require-existing-community
                         Fail before creating smoke users or communities unless --community-id/PIRATE_SMOKE_COMMUNITY_ID is set.
  --host-subject <sub>   Stable upstream auth subject for the host. Can also be set with PIRATE_SMOKE_HOST_SUBJECT.
  --buyer-subject <sub>  Stable upstream auth subject for the buyer. Can also be set with PIRATE_SMOKE_BUYER_SUBJECT.

Required env for staging:
  AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET
  AGORA_APP_ID and AGORA_APP_CERTIFICATE configured in the API environment
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function startBrowserMediaPublisher(input: {
  agora: RuntimeAgoraBlock
  runId: string
}): Promise<{ session: string; close: () => Promise<void> } | null> {
  if (!hasFlag("--publish-browser-media")) return null
  assert(input.agora.app_id, "browser media publisher requires Agora app_id")
  assert(input.agora.token, "browser media publisher requires Agora token")

  const session = `paid-live-smoke-${input.runId}`
  const htmlPath = join(tmpdir(), `${session}.html`)
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Agora Smoke Publisher</title>
    <style>body{font-family:sans-serif;margin:24px}#status{font-weight:700}</style>
  </head>
  <body>
    <div id="status">starting</div>
    <script src="https://download.agora.io/sdk/release/AgoraRTC_N-4.23.2.js"></script>
    <script>
      const appId = ${JSON.stringify(input.agora.app_id)};
      const channel = ${JSON.stringify(input.agora.channel)};
      const token = ${JSON.stringify(input.agora.token)};
      const uid = ${JSON.stringify(input.agora.uid)};
      const status = document.getElementById("status");
      async function main() {
        const client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
        client.setClientRole("host");
        await client.join(appId, channel, token, uid);
        const audio = await AgoraRTC.createMicrophoneAudioTrack();
        await client.publish([audio]);
        window.__pirateAgoraClient = client;
        window.__pirateAgoraTracks = [audio];
        status.textContent = "published " + channel + " uid " + uid;
      }
      main().catch((error) => {
        console.error(error);
        status.textContent = "error: " + (error && error.message ? error.message : String(error));
      });
    </script>
  </body>
</html>`
  await writeFile(htmlPath, html, { mode: 0o600 })
  const args = [
    "--session",
    session,
    "--allow-file-access",
    "--args",
    "--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream,--autoplay-policy=no-user-gesture-required,--no-sandbox",
    "open",
    `file://${htmlPath}`,
  ]
  const opened = spawnSync("agent-browser", args, { stdio: "inherit" })
  assert(opened.status === 0, `agent-browser publisher failed to open; exit ${opened.status}`)
  const waited = spawnSync("agent-browser", ["--session", session, "wait", "--text", "published"], { stdio: "inherit" })
  assert(waited.status === 0, `agent-browser publisher did not report published; exit ${waited.status}`)
  console.log("[paid-live-smoke] browser media publisher", {
    channel: input.agora.channel,
    session,
    uid: input.agora.uid,
  })
  return {
    session,
    close: async () => {
      if (!hasFlag("--skip-browser-media-cleanup")) {
        spawnSync("agent-browser", ["--session", session, "close"], { stdio: "ignore" })
      }
      await rm(htmlPath, { force: true })
    },
  }
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

async function createPurchaseQuote(input: {
  apiBaseUrl: string
  buyer: SmokeSession
  communityId: string
  env: Record<string, string | undefined>
  listingId: string
  roomId: string
}): Promise<{ failedClosed: true }> {
  const chainId = resolveCheckoutSourceChainId(input.env)
  // Paid live-room ticket checkout is failed closed until recipient payout execution exists.
  // The canary verifies the API rejects quote creation rather than issuing an unpayable checkout.
  const result = await apiResult<{ code?: string; message?: string }>({
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

  assert(
    result.status === 403,
    `expected paid ticket checkout to fail closed with 403, got ${result.status}: ${JSON.stringify(result.body)}`,
  )
  assert(
    JSON.stringify(result.body).includes("recipient payout is not configured"),
    `unexpected fail-closed reason: ${JSON.stringify(result.body)}`,
  )
  console.log("[paid-live-smoke] paid ticket checkout correctly failed closed", { room: input.roomId })
  return { failedClosed: true }
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
  const recordingEnabled = hasFlag("--recording-enabled")
  const requireExistingCommunity = hasFlag("--require-existing-community")
  if (requireExistingCommunity && !existingCommunityId) {
    throw new Error("--require-existing-community requires --community-id or PIRATE_SMOKE_COMMUNITY_ID")
  }
  const skipVerification = hasFlag("--skip-verification")
  let host: SmokeSession | null = null
  let communityId = ""
  let roomId: string | null = null
  let hostAttached = false
  let browserPublisher: { close: () => Promise<void> } | null = null

  try {
    console.log("[paid-live-smoke] start", {
      api_base_url: apiBaseUrl,
      price_cents: priceCents,
      recording_enabled: recordingEnabled,
      run_id: runId,
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
    browserPublisher = await startBrowserMediaPublisher({
      agora: hostAgora,
      runId,
    })
    if (recordingEnabled) {
      await assertRecordingDraftProcessing({
        apiBaseUrl,
        communityId,
        host,
        roomId,
      })
    }
    const quote = await createPurchaseQuote({
      apiBaseUrl,
      buyer,
      communityId,
      env,
      listingId: published.listingId,
      roomId,
    })
    assert(quote.failedClosed, "expected paid ticket checkout to fail closed")

    console.log("[paid-live-smoke] paid live-room checkout failed closed as expected", {
      anchor_post: published.postId,
      community: communityId,
      listing: published.listingId,
      room: roomId,
    })
  } finally {
    if (browserPublisher) {
      await browserPublisher.close()
      browserPublisher = null
    }
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
