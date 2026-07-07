export {}

type RequestResult = {
  cf_cache_status: string | null
  elapsed_ms: number
  server_timing: string | null
  status: number
  size_bytes: number
  url: string
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function requiredArg(name: string): string {
  const value = readArg(name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function usage(): string {
  return `Usage:
  bun run scripts/smoke-public-read-cache.ts --post post_pst_... --community com_cmt_... [options]

Options:
  --origin <url>       Pirate API origin. Defaults to https://api.pirate.sc.
  --post <post_id>     Public post id, e.g. post_pst_...
  --community <id>     Public community id, e.g. com_cmt_...
  --locale <locale>    Optional locale query parameter.
  --skip-purge         Only prove warm HIT behavior; do not call Cloudflare purge.
  --max-hit-ms <ms>    Maximum accepted HIT duration. Defaults to 1000.

Environment for purge mode:
  CLOUDFLARE_CACHE_PURGE_ZONE_ID or CLOUDFLARE_ZONE_ID
  CLOUDFLARE_CACHE_PURGE_API_TOKEN or CLOUDFLARE_API_TOKEN
`
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "")
}

function publicReadUrls(input: {
  origin: string
  postId: string
  locale: string | null
}): { post: string; thread: string } {
  const post = new URL(`/public-posts/${encodeURIComponent(input.postId)}`, input.origin)
  const thread = new URL(`/public-posts/${encodeURIComponent(input.postId)}/thread`, input.origin)
  if (input.locale) {
    post.searchParams.set("locale", input.locale)
    thread.searchParams.set("locale", input.locale)
  }
  return { post: post.toString(), thread: thread.toString() }
}

async function requestJson(url: string): Promise<RequestResult> {
  const startedAt = performance.now()
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
    },
  })
  const body = await response.arrayBuffer()
  return {
    cf_cache_status: response.headers.get("cf-cache-status"),
    elapsed_ms: Math.round(performance.now() - startedAt),
    server_timing: response.headers.get("server-timing"),
    status: response.status,
    size_bytes: body.byteLength,
    url,
  }
}

function assertOk(result: RequestResult, label: string): void {
  if (result.status !== 200) {
    throw new Error(`${label} returned HTTP ${result.status}`)
  }
}

function assertHit(result: RequestResult, label: string, maxHitMs: number): void {
  assertOk(result, label)
  if (result.cf_cache_status !== "HIT") {
    throw new Error(`${label} was not a Cloudflare HIT: cf-cache-status=${result.cf_cache_status}`)
  }
  if (result.elapsed_ms > maxHitMs) {
    throw new Error(`${label} HIT took ${result.elapsed_ms}ms, expected <= ${maxHitMs}ms`)
  }
}

function assertMissAfterPurge(result: RequestResult, label: string): void {
  assertOk(result, label)
  if (result.cf_cache_status === "HIT") {
    throw new Error(`${label} remained a Cloudflare HIT after purge`)
  }
}

async function warmEndpoint(url: string, label: string, maxHitMs: number): Promise<{
  first: RequestResult
  second: RequestResult
}> {
  const first = await requestJson(url)
  assertOk(first, `${label}.first`)
  const second = await requestJson(url)
  assertHit(second, `${label}.second`, maxHitMs)
  return { first, second }
}

function cloudflarePurgeConfig(): { zoneId: string; token: string } {
  const zoneId = process.env.CLOUDFLARE_CACHE_PURGE_ZONE_ID?.trim()
    || process.env.CLOUDFLARE_ZONE_ID?.trim()
  const token = process.env.CLOUDFLARE_CACHE_PURGE_API_TOKEN?.trim()
    || process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (!zoneId || !token) {
    throw new Error("Cloudflare purge env is required unless --skip-purge is set")
  }
  return { zoneId, token }
}

async function purgeTags(tags: string[]): Promise<unknown> {
  const { zoneId, token } = cloudflarePurgeConfig()
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: [...new Set(tags)] }),
    },
  )
  const text = await response.text()
  let body: { success?: unknown; errors?: unknown } | null = null
  try {
    body = text ? JSON.parse(text) as { success?: unknown; errors?: unknown } : null
  } catch {
    throw new Error(`Cloudflare purge returned invalid JSON: ${text.slice(0, 500)}`)
  }
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare purge failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return body
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage())
    return
  }

  const origin = normalizeOrigin(readArg("--origin") ?? "https://api.pirate.sc")
  const postId = requiredArg("--post")
  const communityId = requiredArg("--community")
  const locale = readArg("--locale")?.trim() || null
  const skipPurge = hasFlag("--skip-purge")
  const maxHitMs = Number(readArg("--max-hit-ms") ?? "1000")
  if (!Number.isFinite(maxHitMs) || maxHitMs <= 0) throw new Error("--max-hit-ms must be a positive number")

  const urls = publicReadUrls({ origin, postId, locale })
  const tags = [`post:${postId}`, `community:${communityId}`]

  const before = {
    post: await warmEndpoint(urls.post, "post.before", maxHitMs),
    thread: await warmEndpoint(urls.thread, "thread.before", maxHitMs),
  }

  let purge: unknown = null
  let after: {
    post?: { miss: RequestResult; hit: RequestResult }
    thread?: { miss: RequestResult; hit: RequestResult }
  } | null = null
  if (!skipPurge) {
    purge = await purgeTags(tags)
    const postMiss = await requestJson(urls.post)
    assertMissAfterPurge(postMiss, "post.after_purge")
    const threadMiss = await requestJson(urls.thread)
    assertMissAfterPurge(threadMiss, "thread.after_purge")
    const postHit = await requestJson(urls.post)
    assertHit(postHit, "post.after_purge_repeat", maxHitMs)
    const threadHit = await requestJson(urls.thread)
    assertHit(threadHit, "thread.after_purge_repeat", maxHitMs)
    after = {
      post: { miss: postMiss, hit: postHit },
      thread: { miss: threadMiss, hit: threadHit },
    }
  }

  console.log(JSON.stringify({
    ok: true,
    origin,
    post_id: postId,
    community_id: communityId,
    locale,
    tags,
    before,
    purge,
    after,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
