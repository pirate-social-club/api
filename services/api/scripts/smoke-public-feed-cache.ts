export {}

type SmokeResult = {
  cache_status: string | null
  cf_cache_status: string | null
  deduped: boolean
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

function usage(): string {
  return `Usage:
  bun run scripts/smoke-public-feed-cache.ts [options]

Options:
  --origin <url>       Pirate API origin. Defaults to https://api.pirate.sc.
  --web-origin <url>   Origin header. Defaults from --origin.
  --sort <value>       Feed sort. Defaults to best.
  --locale <value>     Feed locale. Defaults to en.
  --cache-bust         Use a unique query param to force a cold cache key.
  --dedupe             Run two concurrent cold requests and check x-pirate-cache-deduped.
  --max-hit-ms <ms>    Maximum accepted follow-up hit duration. Defaults to 1000.
`
}

function defaultWebOrigin(apiOrigin: string): string {
  return apiOrigin.includes("staging") ? "https://staging.pirate.sc" : "https://pirate.sc"
}

function buildFeedUrl(input: {
  origin: string
  sort: string
  locale: string
  cacheBust: string | null
}): string {
  const url = new URL("/feed/home/public", input.origin)
  url.searchParams.set("sort", input.sort)
  url.searchParams.set("locale", input.locale)
  if (input.cacheBust) url.searchParams.set("smoke", input.cacheBust)
  return url.toString()
}

async function requestFeed(url: string, webOrigin: string): Promise<SmokeResult> {
  const startedAt = performance.now()
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Origin": webOrigin,
    },
  })
  const body = await response.arrayBuffer()
  return {
    cache_status: response.headers.get("x-pirate-cache"),
    cf_cache_status: response.headers.get("cf-cache-status"),
    deduped: response.headers.get("x-pirate-cache-deduped") === "1",
    elapsed_ms: Math.round(performance.now() - startedAt),
    server_timing: response.headers.get("server-timing"),
    status: response.status,
    size_bytes: body.byteLength,
    url,
  }
}

function assertOk(result: SmokeResult, label: string): void {
  if (result.status !== 200) {
    throw new Error(`${label} returned HTTP ${result.status}`)
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage())
    return
  }

  const origin = (readArg("--origin") ?? "https://api.pirate.sc").replace(/\/+$/, "")
  const webOrigin = readArg("--web-origin") ?? defaultWebOrigin(origin)
  const sort = readArg("--sort") ?? "best"
  const locale = readArg("--locale") ?? "en"
  const maxHitMs = Number(readArg("--max-hit-ms") ?? "1000")
  if (!Number.isFinite(maxHitMs) || maxHitMs <= 0) throw new Error("--max-hit-ms must be a positive number")

  const cacheBust = hasFlag("--cache-bust") || hasFlag("--dedupe")
    ? `public-feed-cache-${Date.now()}`
    : null
  const url = buildFeedUrl({ origin, sort, locale, cacheBust })

  let concurrent: SmokeResult[] | null = null
  if (hasFlag("--dedupe")) {
    concurrent = await Promise.all([
      requestFeed(url, webOrigin),
      requestFeed(url, webOrigin),
    ])
    concurrent.forEach((result, index) => assertOk(result, `concurrent[${index}]`))
    if (!concurrent.some((result) => result.deduped)) {
      throw new Error("concurrent cold requests did not observe x-pirate-cache-deduped: 1")
    }
  } else {
    const first = await requestFeed(url, webOrigin)
    assertOk(first, "first")
    concurrent = [first]
  }

  const followup = await requestFeed(url, webOrigin)
  assertOk(followup, "followup")
  if (followup.cache_status !== "hit" && followup.cf_cache_status !== "HIT") {
    throw new Error(`followup was not a cache hit: x-pirate-cache=${followup.cache_status}, cf-cache-status=${followup.cf_cache_status}`)
  }
  if (followup.elapsed_ms > maxHitMs) {
    throw new Error(`followup cache hit took ${followup.elapsed_ms}ms, expected <= ${maxHitMs}ms`)
  }

  console.log(JSON.stringify({
    ok: true,
    origin,
    web_origin: webOrigin,
    sort,
    locale,
    cache_bust: cacheBust,
    concurrent,
    followup,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
