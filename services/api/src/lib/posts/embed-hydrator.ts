import { detectSupportedEmbedTarget } from "./embed-url-detection"
import { fetchLinkPreviewMetadata } from "./link-preview-fetcher"
import {
  extractTweetMediaUrl,
  extractTweetText,
  fetchXPostOEmbed,
  fetchYouTubeOEmbed,
} from "./link-embed-preview"
import { hydrateGenericLinkEnrichment } from "./link-enrichment/service"
import { upsertPostEmbed, refreshPostEmbedsProjection } from "./post-embed-store"
import { updatePostLinkPreviewMetadata } from "./community-post-store"
import type { DbExecutor } from "../db-helpers"
import type { Post } from "../../types"
import type { Env } from "../../env"
import type { Client } from "../sql-client"

type PostEmbed = NonNullable<Post["embeds"]>[number]
type XPostEmbed = Extract<PostEmbed, { provider: "x" }>
type YouTubeVideoEmbed = Extract<PostEmbed, { provider: "youtube" }>
type KalshiMarketEmbed = Extract<PostEmbed, { provider: "kalshi" }>
type PolymarketMarketEmbed = Extract<PostEmbed, { provider: "polymarket" }>
type PredictionMarketPreview = KalshiMarketEmbed["preview"] | PolymarketMarketEmbed["preview"]

const MARKET_EMBED_TIMEOUT_MS = 8_000
const MARKET_CHART_DAYS = 30

function numberField(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function stringField(value: unknown): string | null {
  const text = String(value ?? "").trim()
  return text || null
}

function parseNumberField(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/gu, ""))
  return Number.isFinite(parsed) ? parsed : null
}

function centsToProbability(value: unknown): number | null {
  const parsed = parseNumberField(value)
  if (parsed === null) return null
  return parsed > 1 ? parsed / 100 : parsed
}

function parseJsonArrayField(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value !== "string") {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function compactChart(points: NonNullable<PredictionMarketPreview>["chart"]): NonNullable<PredictionMarketPreview>["chart"] {
  if (!points?.length) {
    return null
  }
  return points
    .filter((point) => Number.isFinite(point.ts) && point.price !== null && point.price !== undefined)
    .slice(-MARKET_CHART_DAYS)
}

async function fetchJsonWithTimeout(input: {
  fetcher: typeof fetch
  url: string
  timeoutMs?: number
}): Promise<unknown | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? MARKET_EMBED_TIMEOUT_MS)
  try {
    const response = await input.fetcher(input.url, {
      headers: {
        accept: "application/json",
        "user-agent": "Pirate embed hydrator",
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }
    return await response.json() as unknown
  } finally {
    clearTimeout(timeout)
  }
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function parseKalshiChart(body: unknown): NonNullable<PredictionMarketPreview>["chart"] {
  const markets = parseJsonArrayField(objectField(body, "markets"))
  const firstMarket = markets[0]
  const candlesticks = parseJsonArrayField(objectField(firstMarket, "candlesticks"))
  return compactChart(candlesticks.map((point) => {
    const price = objectField(point, "price")
    return {
      ts: parseNumberField(objectField(point, "end_period_ts")) ?? 0,
      price: centsToProbability(objectField(price, "close_dollars") ?? objectField(price, "previous_dollars")),
      volume: parseNumberField(objectField(point, "volume_fp")),
      open_interest: parseNumberField(objectField(point, "open_interest_fp")),
    }
  }))
}

function parsePolymarketChart(body: unknown): NonNullable<PredictionMarketPreview>["chart"] {
  const history = parseJsonArrayField(objectField(body, "history"))
  return compactChart(history.map((point) => ({
    ts: parseNumberField(objectField(point, "t")) ?? 0,
    price: centsToProbability(objectField(point, "p")),
    volume: null,
    open_interest: null,
  })))
}

function isResolvedMarketStatus(value: string | null): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized === "settled" || normalized === "resolved" || normalized === "determined"
}

function deriveResolutionFromYesPrice(value: number | null): "yes" | "no" | null {
  if (value === null) return null
  if (value >= 0.95) return "yes"
  if (value <= 0.05) return "no"
  return null
}

async function hydrateKalshiMarketEmbed(input: {
  client: DbExecutor
  post: Post
  target: Extract<ReturnType<typeof detectSupportedEmbedTarget>, { provider: "kalshi" }>
  checkedAt: string
  fetcher: typeof fetch
}): Promise<string | null> {
  const urlTicker = input.target.providerRef.toUpperCase()
  let market: unknown = null
  let resolvedTicker = urlTicker

  // Try direct market lookup first
  const directMarketUrl = `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(urlTicker)}`
  const directMarketBody = await fetchJsonWithTimeout({ fetcher: input.fetcher, url: directMarketUrl })
  market = objectField(directMarketBody, "market")

  // If direct lookup fails, try resolving via event ticker
  if (!market || typeof market !== "object") {
    const eventMarketsUrl = new URL("https://api.elections.kalshi.com/trade-api/v2/markets")
    eventMarketsUrl.searchParams.set("event_ticker", urlTicker)
    eventMarketsUrl.searchParams.set("limit", "1")
    const eventMarketsBody = await fetchJsonWithTimeout({ fetcher: input.fetcher, url: eventMarketsUrl.href })
    const markets = parseJsonArrayField(objectField(eventMarketsBody, "markets"))
    const firstMarket = markets[0]
    if (firstMarket && typeof firstMarket === "object") {
      market = firstMarket
      const eventMarketTicker = stringField(objectField(firstMarket, "ticker"))
      if (eventMarketTicker) {
        resolvedTicker = eventMarketTicker
      }
    }
  }

  if (!market || typeof market !== "object") {
    // Store an unavailable embed so the frontend shows a graceful fallback
    // instead of falling through to a generic link preview that shows nothing
    const fallbackMetadata = await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.target.canonicalUrl,
    })

    await upsertPostEmbed({
      client: input.client,
      communityId: input.post.community_id,
      postId: input.post.post_id,
      embedKey: input.target.embedKey,
      provider: "kalshi",
      providerRef: urlTicker,
      canonicalUrl: input.target.canonicalUrl,
      originalUrl: input.target.originalUrl,
      state: "unavailable",
      preview: null,
      oembedHtml: null,
      oembedCacheAge: 300,
      unavailableReason: "unknown",
      checkedAt: input.checkedAt,
    })

    await updatePostLinkPreviewMetadata({
      client: input.client,
      postId: input.post.post_id,
      linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
      linkOgTitle: fallbackMetadata?.title ?? null,
      updatedAt: input.checkedAt,
    })

    return input.target.canonicalUrl
  }

  const endTs = Math.floor(Date.parse(input.checkedAt) / 1000)
  const startTs = endTs - MARKET_CHART_DAYS * 24 * 60 * 60
  const chartUrl = new URL("https://api.elections.kalshi.com/trade-api/v2/markets/candlesticks")
  chartUrl.searchParams.set("market_tickers", resolvedTicker)
  chartUrl.searchParams.set("start_ts", String(startTs))
  chartUrl.searchParams.set("end_ts", String(endTs))
  chartUrl.searchParams.set("period_interval", "1440")
  chartUrl.searchParams.set("include_latest_before_start", "true")
  const chartBody = await fetchJsonWithTimeout({ fetcher: input.fetcher, url: chartUrl.href })

  const title = stringField(objectField(market, "title"))
  const status = stringField(objectField(market, "status"))
  const lastPrice = centsToProbability(objectField(market, "last_price"))
  const yesAsk = centsToProbability(objectField(market, "yes_ask"))
  const preview: KalshiMarketEmbed["preview"] = {
    question: title,
    title,
    image_url: null,
    yes_price: yesAsk ?? lastPrice,
    yes_bid: centsToProbability(objectField(market, "yes_bid")),
    yes_ask: yesAsk,
    no_bid: centsToProbability(objectField(market, "no_bid")),
    no_ask: centsToProbability(objectField(market, "no_ask")),
    last_price: lastPrice,
    volume: parseNumberField(objectField(market, "volume")),
    volume_24h: parseNumberField(objectField(market, "volume_24h")),
    liquidity: parseNumberField(objectField(market, "liquidity")),
    open_interest: parseNumberField(objectField(market, "open_interest")),
    status,
    resolution: isResolvedMarketStatus(status) ? deriveResolutionFromYesPrice(lastPrice) : null,
    resolved_outcome: null,
    close_time: stringField(objectField(market, "close_time") ?? objectField(market, "expiration_time")),
    updated_at: input.checkedAt,
    chart: parseKalshiChart(chartBody),
  }

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "kalshi",
    providerRef: resolvedTicker,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state: "embed",
    preview,
    oembedHtml: null,
    oembedCacheAge: 300,
    unavailableReason: null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: null,
    linkOgTitle: title,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}

function firstClobTokenId(market: unknown): string | null {
  const tokenIds = parseJsonArrayField(objectField(market, "clobTokenIds"))
  const first = tokenIds[0]
  return typeof first === "string" && first.trim() ? first.trim() : null
}

const MAX_EVENT_OUTCOMES = 3

async function fetchPolymarketEvent(input: {
  fetcher: typeof fetch
  eventSlug: string
}): Promise<unknown | null> {
  return fetchJsonWithTimeout({
    fetcher: input.fetcher,
    url: `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(input.eventSlug)}`,
  })
}

function parsePolymarketEventOutcomes(eventBody: unknown): Array<{ label: string; probability: number }> {
  const markets = parseJsonArrayField(objectField(eventBody, "markets"))
  return markets
    .map((market) => {
      const outcomes = parseJsonArrayField(objectField(market, "outcomes"))
      const outcomePrices = parseJsonArrayField(objectField(market, "outcomePrices"))
      const question = stringField(objectField(market, "question") ?? objectField(market, "title"))
      if (!question) return null
      const yesIndex = Math.max(0, outcomes.findIndex((o) => String(o).toLowerCase() === "yes"))
      const price = centsToProbability(outcomePrices[yesIndex])
      return price === null ? null : { label: question, probability: price }
    })
    .filter((item): item is { label: string; probability: number } => item !== null)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_EVENT_OUTCOMES)
}

function deriveResolvedOutcome(outcomes: Array<{ label: string; probability: number }>): string | null {
  const winner = outcomes.find((outcome) => outcome.probability >= 0.95)
  return winner?.label ?? null
}

async function hydratePolymarketEventEmbed(input: {
  client: DbExecutor
  post: Post
  target: Extract<ReturnType<typeof detectSupportedEmbedTarget>, { provider: "polymarket" }>
  checkedAt: string
  fetcher: typeof fetch
}): Promise<string | null> {
  const eventBody = await fetchPolymarketEvent({
    fetcher: input.fetcher,
    eventSlug: input.target.eventSlug ?? input.target.providerRef,
  })

  if (!eventBody || typeof eventBody !== "object") {
    const fallbackMetadata = await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.target.canonicalUrl,
    })

    await upsertPostEmbed({
      client: input.client,
      communityId: input.post.community_id,
      postId: input.post.post_id,
      embedKey: input.target.embedKey,
      provider: "polymarket",
      providerRef: input.target.providerRef,
      canonicalUrl: input.target.canonicalUrl,
      originalUrl: input.target.originalUrl,
      state: "unavailable",
      preview: null,
      oembedHtml: null,
      oembedCacheAge: 300,
      unavailableReason: "unknown",
      checkedAt: input.checkedAt,
    })

    await updatePostLinkPreviewMetadata({
      client: input.client,
      postId: input.post.post_id,
      linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
      linkOgTitle: fallbackMetadata?.title ?? null,
      updatedAt: input.checkedAt,
    })

    return input.target.canonicalUrl
  }

  const title = stringField(objectField(eventBody, "title"))
  const imageUrl = stringField(objectField(eventBody, "image") ?? objectField(eventBody, "icon"))
  const outcomes = parsePolymarketEventOutcomes(eventBody)
  if (!outcomes.length) {
    const fallbackMetadata = await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.target.canonicalUrl,
    })

    await upsertPostEmbed({
      client: input.client,
      communityId: input.post.community_id,
      postId: input.post.post_id,
      embedKey: input.target.embedKey,
      provider: "polymarket",
      providerRef: input.target.providerRef,
      canonicalUrl: input.target.canonicalUrl,
      originalUrl: input.target.originalUrl,
      state: "unavailable",
      preview: null,
      oembedHtml: null,
      oembedCacheAge: 300,
      unavailableReason: "unknown",
      checkedAt: input.checkedAt,
    })

    await updatePostLinkPreviewMetadata({
      client: input.client,
      postId: input.post.post_id,
      linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
      linkOgTitle: fallbackMetadata?.title ?? null,
      updatedAt: input.checkedAt,
    })

    return input.target.canonicalUrl
  }

  const isClosed = objectField(eventBody, "closed") === true
  const status = isClosed ? "closed" : objectField(eventBody, "active") === true ? "active" : null
  const preview: PolymarketMarketEmbed["preview"] = {
    question: title,
    title,
    image_url: imageUrl,
    yes_price: null,
    yes_bid: null,
    yes_ask: null,
    no_bid: null,
    no_ask: null,
    last_price: null,
    volume: parseNumberField(objectField(eventBody, "volume")),
    volume_24h: null,
    liquidity: parseNumberField(objectField(eventBody, "liquidity")),
    open_interest: null,
    status,
    resolution: null,
    resolved_outcome: isClosed ? deriveResolvedOutcome(outcomes) : null,
    close_time: stringField(objectField(eventBody, "endDate") ?? objectField(eventBody, "endDateIso")),
    updated_at: input.checkedAt,
    chart: null,
    outcomes,
  }

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "polymarket",
    providerRef: input.target.providerRef,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state: "embed",
    preview,
    oembedHtml: null,
    oembedCacheAge: 300,
    unavailableReason: null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: imageUrl,
    linkOgTitle: title,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}

async function fetchPolymarketMarket(input: {
  fetcher: typeof fetch
  marketSlug: string
  eventSlug: string | null
}): Promise<unknown | null> {
  const marketBody = await fetchJsonWithTimeout({
    fetcher: input.fetcher,
    url: `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(input.marketSlug)}`,
  })
  if (marketBody) {
    return marketBody
  }
  if (!input.eventSlug) {
    return null
  }
  const eventBody = await fetchJsonWithTimeout({
    fetcher: input.fetcher,
    url: `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(input.eventSlug)}`,
  })
  const markets = parseJsonArrayField(objectField(eventBody, "markets"))
  return markets[0] ?? eventBody
}

async function hydratePolymarketMarketEmbed(input: {
  client: DbExecutor
  post: Post
  target: Extract<ReturnType<typeof detectSupportedEmbedTarget>, { provider: "polymarket" }>
  checkedAt: string
  fetcher: typeof fetch
}): Promise<string | null> {
  const market = await fetchPolymarketMarket({
    fetcher: input.fetcher,
    marketSlug: input.target.providerRef,
    eventSlug: input.target.eventSlug,
  })
  if (!market || typeof market !== "object") {
    const fallbackMetadata = await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.target.canonicalUrl,
    })

    await upsertPostEmbed({
      client: input.client,
      communityId: input.post.community_id,
      postId: input.post.post_id,
      embedKey: input.target.embedKey,
      provider: "polymarket",
      providerRef: input.target.providerRef,
      canonicalUrl: input.target.canonicalUrl,
      originalUrl: input.target.originalUrl,
      state: "unavailable",
      preview: null,
      oembedHtml: null,
      oembedCacheAge: 300,
      unavailableReason: "unknown",
      checkedAt: input.checkedAt,
    })

    await updatePostLinkPreviewMetadata({
      client: input.client,
      postId: input.post.post_id,
      linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
      linkOgTitle: fallbackMetadata?.title ?? null,
      updatedAt: input.checkedAt,
    })

    return input.target.canonicalUrl
  }

  const outcomes = parseJsonArrayField(objectField(market, "outcomes"))
  const outcomePrices = parseJsonArrayField(objectField(market, "outcomePrices"))
  const yesIndex = Math.max(0, outcomes.findIndex((outcome) => String(outcome).toLowerCase() === "yes"))
  const yesPrice = centsToProbability(outcomePrices[yesIndex])
  const tokenId = firstClobTokenId(market)
  let chart: NonNullable<PredictionMarketPreview>["chart"] = null
  if (tokenId) {
    const chartUrl = new URL("https://clob.polymarket.com/prices-history")
    chartUrl.searchParams.set("market", tokenId)
    chartUrl.searchParams.set("interval", "1m")
    chartUrl.searchParams.set("fidelity", "1440")
    chart = parsePolymarketChart(await fetchJsonWithTimeout({ fetcher: input.fetcher, url: chartUrl.href }))
  }

  const question = stringField(objectField(market, "question") ?? objectField(market, "title"))
  const imageUrl = stringField(objectField(market, "image") ?? objectField(market, "icon") ?? objectField(market, "twitterCardImage"))
  const isClosed = objectField(market, "closed") === true
  const status = isClosed ? "closed" : objectField(market, "active") === true ? "active" : null
  const preview: PolymarketMarketEmbed["preview"] = {
    question,
    title: question,
    image_url: imageUrl,
    yes_price: yesPrice,
    yes_bid: centsToProbability(objectField(market, "bestBid")),
    yes_ask: centsToProbability(objectField(market, "bestAsk")),
    no_bid: null,
    no_ask: null,
    last_price: centsToProbability(objectField(market, "lastTradePrice")) ?? yesPrice,
    volume: parseNumberField(objectField(market, "volumeNum") ?? objectField(market, "volume")),
    volume_24h: parseNumberField(objectField(market, "volume24hr")),
    liquidity: parseNumberField(objectField(market, "liquidityNum") ?? objectField(market, "liquidity")),
    open_interest: parseNumberField(objectField(market, "openInterest")),
    status,
    resolution: isClosed ? deriveResolutionFromYesPrice(yesPrice) : null,
    resolved_outcome: null,
    close_time: stringField(objectField(market, "endDateIso") ?? objectField(market, "endDate")),
    updated_at: input.checkedAt,
    chart,
  }

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "polymarket",
    providerRef: input.target.providerRef,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state: "embed",
    preview,
    oembedHtml: null,
    oembedCacheAge: 300,
    unavailableReason: null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: imageUrl,
    linkOgTitle: question,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}

async function hydrateXPostEmbed(input: {
  client: DbExecutor
  post: Post
  target: Extract<ReturnType<typeof detectSupportedEmbedTarget>, { provider: "x" }>
  checkedAt: string
  fetcher: typeof fetch
}): Promise<string | null> {
  const oembed = await fetchXPostOEmbed({
    canonicalUrl: input.target.canonicalUrl,
    fetcher: input.fetcher,
  })
  const fallbackMetadata = await fetchLinkPreviewMetadata({
    fetcher: input.fetcher,
    url: input.target.canonicalUrl,
    userAgent: "Twitterbot",
  })

  const extractedMediaUrl = oembed ? extractTweetMediaUrl(oembed.html) : null
  const preview: XPostEmbed["preview"] = {
    author_name: oembed?.authorName ?? null,
    author_url: oembed?.authorUrl ?? null,
    text: oembed ? extractTweetText(oembed.html) : fallbackMetadata?.title ?? null,
    has_media: Boolean(fallbackMetadata?.imageUrl || extractedMediaUrl),
    media_url: fallbackMetadata?.imageUrl ?? extractedMediaUrl ?? null,
    created: null,
  }
  const state: XPostEmbed["state"] = oembed ? "embed" : "unavailable"

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "x",
    providerRef: input.target.providerRef,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state,
    preview,
    oembedHtml: oembed?.html ?? null,
    oembedCacheAge: oembed?.cacheAge ?? null,
    unavailableReason: state === "unavailable" ? "unknown" : null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
    linkOgTitle: oembed ? preview.text ?? oembed.authorName : fallbackMetadata?.title ?? null,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}

async function hydrateYouTubeVideoEmbed(input: {
  client: DbExecutor
  post: Post
  target: Extract<ReturnType<typeof detectSupportedEmbedTarget>, { provider: "youtube" }>
  checkedAt: string
  fetcher: typeof fetch
}): Promise<string | null> {
  const oembed = await fetchYouTubeOEmbed({
    canonicalUrl: input.target.canonicalUrl,
    fetcher: input.fetcher,
    videoId: input.target.providerRef,
  })
  const fallbackMetadata = oembed
    ? null
    : await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.target.canonicalUrl,
    })
  const preview: YouTubeVideoEmbed["preview"] = oembed?.preview ?? {
    title: fallbackMetadata?.title ?? null,
    author_name: null,
    author_url: null,
    thumbnail_url: fallbackMetadata?.imageUrl ?? null,
    thumbnail_width: null,
    thumbnail_height: null,
  }
  const state: YouTubeVideoEmbed["state"] = oembed ? "embed" : fallbackMetadata ? "preview" : "unavailable"

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "youtube",
    providerRef: input.target.providerRef,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state,
    preview,
    oembedHtml: oembed?.html ?? null,
    oembedCacheAge: oembed?.cacheAge ?? null,
    unavailableReason: state === "unavailable" ? "unknown" : null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: preview?.thumbnail_url ?? null,
    linkOgTitle: preview?.title ?? null,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}

export async function hydrateLinkPostEmbed(input: {
  client: DbExecutor
  controlPlaneClient?: Client | null
  env?: Env
  post: Post
  checkedAt: string
  fetcher?: typeof fetch
}): Promise<string | null> {
  if (input.post.post_type !== "link" || !input.post.link_url?.trim()) {
    return "skipped:not_link_post"
  }

  const fetcher = input.fetcher ?? fetch
  const target = detectSupportedEmbedTarget(input.post.link_url)
  if (!target) {
    const resultRef = await hydrateGenericLinkEnrichment({
      communityClient: input.client,
      controlPlaneClient: input.controlPlaneClient,
      communityId: input.post.community_id,
      env: input.env,
      postId: input.post.post_id,
      url: input.post.link_url,
      checkedAt: input.checkedAt,
      fetcher,
    })
    if (!resultRef) {
      return "skipped:no_preview_metadata"
    }
    return resultRef
  }

  const result = target.provider === "x"
    ? await hydrateXPostEmbed({ ...input, fetcher, target })
    : target.provider === "youtube"
    ? await hydrateYouTubeVideoEmbed({ ...input, fetcher, target })
    : target.provider === "kalshi"
    ? await hydrateKalshiMarketEmbed({ ...input, fetcher, target })
    : target.isEventOnly
    ? await hydratePolymarketEventEmbed({ ...input, fetcher, target })
    : await hydratePolymarketMarketEmbed({ ...input, fetcher, target })
  await refreshPostEmbedsProjection({
    client: input.client,
    postId: input.post.post_id,
    updatedAt: input.checkedAt,
  })

  return result
}
