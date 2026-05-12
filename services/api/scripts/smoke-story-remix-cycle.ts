import { SignJWT } from "jose"
import { Wallet } from "ethers"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

type SmokeSession = {
  accessToken: string
  userId: string
  walletAddress: string
  walletAttachment: string | null
}

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

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, "")
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
  const response = await fetch(`${input.apiBaseUrl}${input.path}`, {
    method: input.method,
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body == null ? {} : { "content-type": "application/json" }),
      ...(input.bytes == null ? {} : { "content-type": input.contentType ?? "application/octet-stream" }),
    },
    body: input.body == null
      ? input.bytes
      : JSON.stringify(input.body),
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
}): Promise<SmokeSession> {
  const wallet = Wallet.createRandom()
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
  if (!skipVerification) {
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

  const remixTitle = `${titlePrefix} Smoke Remix ${new Date().toISOString()}`
  const remixBundle = await uploadSong({
    apiBaseUrl,
    communityId,
    session: author,
    title: remixTitle,
    filename: "story-smoke-remix.mp3",
    bytes: new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]),
  })
  const remixPost = await createSongPost({
    apiBaseUrl,
    communityId,
    session: author,
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

  if (hasFlag("--create-listing")) {
    const listing = await api<{ id: string; status: string }>({
      apiBaseUrl,
      method: "POST",
      path: `/communities/${encodeURIComponent(communityId)}/listings`,
      token: author.accessToken,
      body: {
        asset: remixPost.asset,
        price_cents: Number(readEnv("PIRATE_SMOKE_PRICE_CENTS", "399")),
        regional_pricing_enabled: false,
        status: "active",
      },
    })
    console.log("[smoke] listing", listing)
  }

  console.log("[smoke] story remix cycle passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
