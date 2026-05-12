import { SignJWT } from "jose"
import { Interface, JsonRpcProvider, Wallet, getAddress } from "ethers"
// @ts-expect-error The API tsconfig only loads bun-types/test, but this script runs under Bun.
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { NativeRoyaltyPolicy, StoryClient, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { normalizeDirectSignerPrivateKey } from "../src/lib/story/story-direct-signer"
import { resolveStoryChainId, resolveStoryRpcUrl } from "../src/lib/story/story-runtime-config"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

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

async function createSession(input: {
  apiBaseUrl: string
  env: Record<string, string | undefined>
  subject: string
  privateKey?: string | null
}): Promise<SmokeSession> {
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

async function uploadSong(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
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

async function readAsset(input: {
  apiBaseUrl: string
  communityId: string
  session: SmokeSession
  asset: string
}): Promise<{
  story_ip?: string | null
  story_license_terms?: string | null
  story_royalty_registration_status?: string | null
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

function resolveCheckoutSourceChainId(env: Record<string, string | undefined>): number {
  const parsed = Number(env.PIRATE_CHECKOUT_SOURCE_CHAIN_ID || "84532")
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 84532
}

function resolveCheckoutChainName(chainId: number): string {
  if (chainId === 8453) return "Base"
  if (chainId === 84532) return "Base Sepolia"
  return `Chain ${chainId}`
}

function resolveStoryChainName(chainId: number): "aeneid" | "mainnet" {
  return chainId === 1514 ? "mainnet" : "aeneid"
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

function resolveStorySmokePrivateKey(env: Record<string, string | undefined>): `0x${string}` {
  const privateKey = normalizeDirectSignerPrivateKey(
    readEnv("PIRATE_SMOKE_STORY_PRIVATE_KEY")
      || env.STORY_OPERATOR_PRIVATE_KEY
      || env.STORY_RUNTIME_PRIVATE_KEY
      || env.MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY,
  )
  if (!privateKey) {
    throw new Error("PIRATE_SMOKE_STORY_PRIVATE_KEY or STORY_OPERATOR_PRIVATE_KEY is required")
  }
  return privateKey as `0x${string}`
}

async function transferOriginalRevenueToVault(input: {
  env: Record<string, string | undefined>
  originalStoryIp: string
  remixStoryIp: string
}): Promise<void> {
  const chainId = resolveStoryChainId(input.env)
  const storyClient = StoryClient.newClient({
    account: privateKeyToAccount(resolveStorySmokePrivateKey(input.env)),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(chainId),
  })
  const result = await storyClient.royalty.transferToVault({
    ipId: input.remixStoryIp as `0x${string}`,
    ancestorIpId: input.originalStoryIp as `0x${string}`,
    royaltyPolicy: NativeRoyaltyPolicy.LAP,
    token: WIP_TOKEN_ADDRESS,
  })
  console.log("[smoke] original parent royalty transferred to vault", {
    original_story_ip: input.originalStoryIp,
    remix_story_ip: input.remixStoryIp,
    tx: result.txHash,
  })
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
  const communityId = requireEnv("PIRATE_SMOKE_COMMUNITY_ID").replace(/^com_/, "")
  const titlePrefix = readEnv("PIRATE_SMOKE_TITLE_PREFIX", "Palestine, Don't Cry")
  const skipVerification = hasFlag("--skip-verification")
  const useLocalSetup = shouldUseLocalMembershipSetup(apiBaseUrl)
  const settlePurchase = hasFlag("--settle-purchase")

  const author = await createSession({
    apiBaseUrl,
    env,
    subject: `story-remix-smoke-author-${Date.now()}`,
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

  const originalTitle = `${titlePrefix} Smoke Original ${new Date().toISOString()}`
  const originalBundle = await uploadSong({
    apiBaseUrl,
    communityId,
    session: author,
    title: originalTitle,
    filename: "story-smoke-original.mp3",
    bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  })
  const originalPost = await createSongPost({
    apiBaseUrl,
    communityId,
    session: author,
    title: originalTitle,
    bundle: originalBundle,
    songMode: "original",
    accessMode: "public",
    rightsBasis: "original",
  })
  const originalAsset = await readAsset({
    apiBaseUrl,
    communityId,
    session: author,
    asset: originalPost.asset,
  })
  console.log("[smoke] original asset", {
    post: originalPost.post,
    asset: originalPost.asset,
    story_ip: originalAsset.story_ip ?? null,
    story_license_terms: originalAsset.story_license_terms ?? null,
    story_royalty_registration_status: originalAsset.story_royalty_registration_status ?? null,
  })
  if (originalAsset.story_royalty_registration_status !== "registered") {
    throw new Error(`original asset was not Story registered: ${JSON.stringify(originalAsset)}`)
  }

  const catalog = await api<{
    items: Array<{ asset: string; title: string; story_ip: string; story_license_terms: string }>
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
  const source = catalog.items.find((item) => item.asset === originalPost.asset) ?? catalog.items[0]
  if (!source) throw new Error("original did not appear in derivative sources")
  const upstreamAssetRefs = [`story:asset:${source.asset}`]

  const remixer = await createSession({
    apiBaseUrl,
    env,
    subject: `story-remix-smoke-remixer-${Date.now()}`,
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

  const remixTitle = `${titlePrefix} Smoke Remix ${new Date().toISOString()}`
  const remixBundle = await uploadSong({
    apiBaseUrl,
    communityId,
    session: remixer,
    title: remixTitle,
    filename: "story-smoke-remix.mp3",
    bytes: new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]),
  })
  const remixPost = await createSongPost({
    apiBaseUrl,
    communityId,
    session: remixer,
    title: remixTitle,
    bundle: remixBundle,
    songMode: "remix",
    accessMode: "public",
    rightsBasis: "derivative",
    upstreamAssetRefs,
  })
  const remixAsset = await readAsset({
    apiBaseUrl,
    communityId,
    session: author,
    asset: remixPost.asset,
  })
  console.log("[smoke] remix asset", {
    post: remixPost.post,
    asset: remixPost.asset,
    story_ip: remixAsset.story_ip ?? null,
    story_royalty_registration_status: remixAsset.story_royalty_registration_status ?? null,
    parents: remixAsset.story_derivative_parent_ip_ids ?? null,
  })
  if (remixAsset.story_royalty_registration_status !== "registered") {
    throw new Error(`remix asset was not Story registered: ${JSON.stringify(remixAsset)}`)
  }
  const parentIps = remixAsset.story_derivative_parent_ip_ids ?? []
  if (!parentIps.some((parentIp) => parentIp.toLowerCase() === originalAsset.story_ip?.toLowerCase())) {
    throw new Error(`remix asset missing original parent IP: ${JSON.stringify(remixAsset)}`)
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
        subject: `story-remix-smoke-buyer-${Date.now()}`,
        privateKey: readEnv("PIRATE_SMOKE_BUYER_PRIVATE_KEY") || env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY,
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
      if (originalAsset.story_ip && remixAsset.story_ip) {
        await transferOriginalRevenueToVault({
          env,
          originalStoryIp: originalAsset.story_ip,
          remixStoryIp: remixAsset.story_ip,
        })
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
