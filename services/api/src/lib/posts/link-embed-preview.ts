import { detectSupportedEmbedTarget } from "./embed-url-detection"
import { fetchLinkPreviewMetadata } from "./link-preview-fetcher"

const X_OEMBED_TIMEOUT_MS = 8_000
const YOUTUBE_OEMBED_TIMEOUT_MS = 8_000

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    switch (normalized) {
      case "amp":
        return "&"
      case "apos":
        return "'"
      case "gt":
        return ">"
      case "lt":
        return "<"
      case "quot":
        return '"'
      default:
        return match
    }
  })
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim()
}

function sanitizeXPostOEmbedHtml(value: unknown): string | null {
  const html = String(value ?? "").trim()
  if (!html || !html.includes("twitter-tweet")) {
    return null
  }

  return html.replace(/<script\b[\s\S]*?<\/script>/giu, "").trim()
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
}

function sanitizeYouTubeVideoOEmbedHtml(input: {
  title: string | null
  videoId: string
}): string {
  const title = escapeHtmlAttribute(input.title || "YouTube video")
  const videoId = encodeURIComponent(input.videoId)
  return `<iframe title="${title}" src="https://www.youtube-nocookie.com/embed/${videoId}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
}

function parseCacheAge(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function extractTweetText(html: string): string | null {
  const paragraphMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(html)
  const text = stripTags(paragraphMatch?.[1] ?? "")
  return text ? text.slice(0, 500) : null
}

export function extractTweetMediaUrl(html: string): string | null {
  const match = html.match(/https?:\/\/pic\.(?:twitter|x)\.com\/[a-zA-Z0-9]+/iu)
  return match?.[0] ?? null
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function stringField(value: unknown): string | null {
  const text = String(value ?? "").trim()
  return text || null
}

type XPostOEmbedResponse = {
  html?: unknown
  cache_age?: unknown
  author_name?: unknown
  author_url?: unknown
}

type YouTubeOEmbedResponse = {
  title?: unknown
  author_name?: unknown
  author_url?: unknown
  thumbnail_url?: unknown
  thumbnail_width?: unknown
  thumbnail_height?: unknown
  html?: unknown
}

export async function fetchXPostOEmbed(input: {
  canonicalUrl: string
  fetcher: typeof fetch
}): Promise<{
  html: string
  cacheAge: number | null
  authorName: string | null
  authorUrl: string | null
} | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), X_OEMBED_TIMEOUT_MS)
  const url = new URL("https://publish.x.com/oembed")
  url.searchParams.set("url", input.canonicalUrl)
  url.searchParams.set("omit_script", "1")
  url.searchParams.set("dnt", "true")
  url.searchParams.set("theme", "dark")

  try {
    const response = await input.fetcher(url.href, {
      headers: {
        accept: "application/json",
        "user-agent": "Pirate embed hydrator",
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }

    const body = await response.json() as XPostOEmbedResponse
    const html = sanitizeXPostOEmbedHtml(body.html)
    if (!html) {
      return null
    }

    return {
      html,
      cacheAge: parseCacheAge(body.cache_age),
      authorName: String(body.author_name ?? "").trim() || null,
      authorUrl: String(body.author_url ?? "").trim() || null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchYouTubeOEmbed(input: {
  canonicalUrl: string
  videoId: string
  fetcher: typeof fetch
}): Promise<{
  html: string
  cacheAge: number | null
  preview: {
    title: string | null
    author_name: string | null
    author_url: string | null
    thumbnail_url: string | null
    thumbnail_width: number | null
    thumbnail_height: number | null
  }
} | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_OEMBED_TIMEOUT_MS)
  const url = new URL("https://www.youtube.com/oembed")
  url.searchParams.set("url", input.canonicalUrl)
  url.searchParams.set("format", "json")

  try {
    const response = await input.fetcher(url.href, {
      headers: {
        accept: "application/json",
        "user-agent": "Pirate embed hydrator",
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }

    const body = await response.json() as YouTubeOEmbedResponse
    const title = String(body.title ?? "").trim() || null
    return {
      html: sanitizeYouTubeVideoOEmbedHtml({
        title,
        videoId: input.videoId,
      }),
      cacheAge: parseCacheAge(response.headers.get("cache-control")?.match(/max-age=(\d+)/iu)?.[1] ?? null),
      preview: {
        title,
        author_name: String(body.author_name ?? "").trim() || null,
        author_url: String(body.author_url ?? "").trim() || null,
        thumbnail_url: String(body.thumbnail_url ?? "").trim() || null,
        thumbnail_width: numberField(body.thumbnail_width),
        thumbnail_height: numberField(body.thumbnail_height),
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

export type ComposerLinkPreviewResult = {
  kind: "embed" | "link"
  provider: "x" | "youtube" | "kalshi" | "polymarket" | null
  canonicalUrl: string
  originalUrl: string
  state: "embed" | "preview" | "unavailable"
  title: string | null
  imageUrl: string | null
  preview: Record<string, unknown> | null
  oembedHtml: string | null
  oembedCacheAge: number | null
}

export async function resolveComposerLinkPreview(input: {
  url: string
  fetcher: typeof fetch
}): Promise<ComposerLinkPreviewResult | null> {
  const target = detectSupportedEmbedTarget(input.url)
  if (!target) {
    const metadata = await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.url,
    })
    if (!metadata.title && !metadata.imageUrl) {
      return null
    }
    return {
      kind: "link",
      provider: null,
      canonicalUrl: input.url,
      originalUrl: input.url,
      state: "preview",
      title: metadata.title,
      imageUrl: metadata.imageUrl,
      preview: null,
      oembedHtml: null,
      oembedCacheAge: null,
    }
  }

  if (target.provider === "x") {
    const oembed = await fetchXPostOEmbed({
      canonicalUrl: target.canonicalUrl,
      fetcher: input.fetcher,
    })
    const fallbackMetadata = await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: target.canonicalUrl,
      userAgent: "Twitterbot",
    })

    const extractedMediaUrl = oembed ? extractTweetMediaUrl(oembed.html) : null
    const preview = {
      author_name: oembed?.authorName ?? null,
      author_url: oembed?.authorUrl ?? null,
      text: oembed ? extractTweetText(oembed.html) : fallbackMetadata?.title ?? null,
      has_media: Boolean(fallbackMetadata?.imageUrl || extractedMediaUrl),
      media_url: fallbackMetadata?.imageUrl ?? extractedMediaUrl ?? null,
      created: null,
    }

    return {
      kind: "embed",
      provider: "x",
      canonicalUrl: target.canonicalUrl,
      originalUrl: target.originalUrl,
      state: oembed ? "embed" : "unavailable",
      title: preview.text ?? oembed?.authorName ?? fallbackMetadata?.title ?? null,
      imageUrl: fallbackMetadata?.imageUrl ?? extractedMediaUrl ?? null,
      preview,
      oembedHtml: oembed?.html ?? null,
      oembedCacheAge: oembed?.cacheAge ?? null,
    }
  }

  if (target.provider === "youtube") {
    const oembed = await fetchYouTubeOEmbed({
      canonicalUrl: target.canonicalUrl,
      videoId: target.providerRef,
      fetcher: input.fetcher,
    })
    const fallbackMetadata = oembed
      ? null
      : await fetchLinkPreviewMetadata({
        fetcher: input.fetcher,
        url: target.canonicalUrl,
      })

    const preview = oembed?.preview ?? {
      title: fallbackMetadata?.title ?? null,
      author_name: null,
      author_url: null,
      thumbnail_url: fallbackMetadata?.imageUrl ?? null,
      thumbnail_width: null,
      thumbnail_height: null,
    }

    return {
      kind: "embed",
      provider: "youtube",
      canonicalUrl: target.canonicalUrl,
      originalUrl: target.originalUrl,
      state: oembed ? "embed" : fallbackMetadata ? "preview" : "unavailable",
      title: preview.title,
      imageUrl: preview.thumbnail_url ?? null,
      preview,
      oembedHtml: oembed?.html ?? null,
      oembedCacheAge: oembed?.cacheAge ?? null,
    }
  }

  // Kalshi and Polymarket fall back to generic link preview for composer
  const metadata = await fetchLinkPreviewMetadata({
    fetcher: input.fetcher,
    url: target.canonicalUrl,
  })

  return {
    kind: "link",
    provider: target.provider,
    canonicalUrl: target.canonicalUrl,
    originalUrl: target.originalUrl,
    state: "preview",
    title: metadata.title,
    imageUrl: metadata.imageUrl,
    preview: null,
    oembedHtml: null,
    oembedCacheAge: null,
  }
}
