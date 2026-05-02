type EmbedTargetBase = {
  providerRef: string
  embedKey: string
  canonicalUrl: string
  originalUrl: string
}
export type XEmbedTarget = EmbedTargetBase & {
  provider: "x"
}
export type YouTubeEmbedTarget = EmbedTargetBase & {
  provider: "youtube"
}
export type KalshiEmbedTarget = EmbedTargetBase & {
  provider: "kalshi"
  seriesSlug: string | null
}
export type PolymarketEmbedTarget = EmbedTargetBase & {
  provider: "polymarket"
  eventSlug: string | null
  isEventOnly: boolean
}
export type SupportedEmbedTarget = XEmbedTarget | YouTubeEmbedTarget | KalshiEmbedTarget | PolymarketEmbedTarget

const X_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
])
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
])
const YOUTUBE_SHORT_HOSTS = new Set([
  "youtu.be",
])
const KALSHI_HOSTS = new Set([
  "kalshi.com",
  "www.kalshi.com",
])
const POLYMARKET_HOSTS = new Set([
  "polymarket.com",
  "www.polymarket.com",
])

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/u, "")
}

function normalizeHttpUrl(value: string | null | undefined): URL | null {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null
  } catch {
    return null
  }
}

function detectXEmbed(url: URL, originalUrl: string): SupportedEmbedTarget | null {
  if (!X_HOSTS.has(normalizeHost(url.hostname))) {
    return null
  }

  const segments = url.pathname.split("/").filter(Boolean)
  let postId: string | null = null
  let handle: string | null = null

  const statusIndex = segments.findIndex((segment) => segment.toLowerCase() === "status")
  if (statusIndex > 0) {
    handle = segments[statusIndex - 1] ?? null
    postId = segments[statusIndex + 1] ?? null
  } else if (segments.length >= 4 && segments[0] === "i" && segments[1] === "web" && segments[2] === "status") {
    postId = segments[3] ?? null
  }

  const normalizedPostId = String(postId ?? "").trim()
  if (!/^\d+$/u.test(normalizedPostId)) {
    return null
  }

  const normalizedHandle = String(handle ?? "").trim()
  const canonicalPath = normalizedHandle
    ? `/${encodeURIComponent(normalizedHandle)}/status/${normalizedPostId}`
    : `/i/web/status/${normalizedPostId}`

  return {
    provider: "x",
    providerRef: normalizedPostId,
    embedKey: `x:${normalizedPostId}`,
    canonicalUrl: `https://x.com${canonicalPath}`,
    originalUrl,
  }
}

function normalizeYouTubeVideoId(value: string | null | undefined): string | null {
  const videoId = String(value ?? "").trim()
  return /^[a-z0-9_-]{11}$/iu.test(videoId) ? videoId : null
}

function detectYouTubeEmbed(url: URL, originalUrl: string): SupportedEmbedTarget | null {
  const host = normalizeHost(url.hostname)
  let videoId: string | null = null

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    videoId = normalizeYouTubeVideoId(url.pathname.split("/").filter(Boolean)[0])
  } else if (YOUTUBE_HOSTS.has(host)) {
    const segments = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/watch") {
      videoId = normalizeYouTubeVideoId(url.searchParams.get("v"))
    } else if (segments[0] === "shorts" || segments[0] === "embed" || segments[0] === "live") {
      videoId = normalizeYouTubeVideoId(segments[1])
    }
  }

  if (!videoId) {
    return null
  }

  return {
    provider: "youtube",
    providerRef: videoId,
    embedKey: `youtube:${videoId}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    originalUrl,
  }
}

function normalizeMarketSlug(value: string | null | undefined): string | null {
  const slug = String(value ?? "").trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{1,199}$/u.test(slug) ? slug : null
}

function detectKalshiMarket(url: URL, originalUrl: string): SupportedEmbedTarget | null {
  if (!KALSHI_HOSTS.has(normalizeHost(url.hostname))) {
    return null
  }

  const segments = url.pathname.split("/").filter(Boolean)
  if (segments[0]?.toLowerCase() !== "markets") {
    return null
  }

  const ticker = normalizeMarketSlug(segments[segments.length - 1])
  if (!ticker) {
    return null
  }

  const seriesSlug = normalizeMarketSlug(segments[1])
  return {
    provider: "kalshi",
    providerRef: ticker.toUpperCase(),
    embedKey: `kalshi:${ticker.toUpperCase()}`,
    canonicalUrl: `https://kalshi.com${url.pathname}`,
    originalUrl,
    seriesSlug,
  }
}

function detectPolymarketMarket(url: URL, originalUrl: string): SupportedEmbedTarget | null {
  if (!POLYMARKET_HOSTS.has(normalizeHost(url.hostname))) {
    return null
  }

  const segments = url.pathname.split("/").filter(Boolean)
  if (segments[0]?.toLowerCase() !== "event") {
    return null
  }

  const eventSlug = normalizeMarketSlug(segments[1])
  const hasMarketSlug = Boolean(segments[2])
  const marketSlug = normalizeMarketSlug(segments[2]) ?? eventSlug
  if (!eventSlug || !marketSlug) {
    return null
  }

  return {
    provider: "polymarket",
    providerRef: marketSlug,
    embedKey: hasMarketSlug ? `polymarket:market:${marketSlug}` : `polymarket:event:${eventSlug}`,
    canonicalUrl: `https://polymarket.com/event/${eventSlug}${hasMarketSlug ? `/${marketSlug}` : ""}`,
    originalUrl,
    eventSlug,
    isEventOnly: !hasMarketSlug,
  }
}

export function detectSupportedEmbedTarget(linkUrl: string | null | undefined): SupportedEmbedTarget | null {
  const parsed = normalizeHttpUrl(linkUrl)
  if (!parsed) {
    return null
  }

  const originalUrl = String(linkUrl ?? "").trim()
  return detectXEmbed(parsed, originalUrl)
    ?? detectYouTubeEmbed(parsed, originalUrl)
    ?? detectKalshiMarket(parsed, originalUrl)
    ?? detectPolymarketMarket(parsed, originalUrl)
}
