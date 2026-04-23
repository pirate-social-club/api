import { detectSupportedEmbedTarget } from "./embed-url-detection"
import { fetchLinkPreviewMetadata } from "./link-preview-fetcher"
import { upsertPostEmbed, refreshPostEmbedsProjection } from "./post-embed-store"
import { updatePostLinkPreviewMetadata } from "./community-post-store"
import type { DbExecutor } from "../db-helpers"
import type { Post } from "../../types"

type PostEmbed = NonNullable<Post["embeds"]>[number]
type XPostEmbed = Extract<PostEmbed, { provider: "x" }>
type YouTubeVideoEmbed = Extract<PostEmbed, { provider: "youtube" }>

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

function extractTweetText(html: string): string | null {
  const paragraphMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(html)
  const text = stripTags(paragraphMatch?.[1] ?? "")
  return text ? text.slice(0, 500) : null
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

async function fetchXPostOEmbed(input: {
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

async function fetchYouTubeOEmbed(input: {
  canonicalUrl: string
  videoId: string
  fetcher: typeof fetch
}): Promise<{
  html: string
  cacheAge: number | null
  preview: YouTubeVideoEmbed["preview"]
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
  })

  const preview: XPostEmbed["preview"] = {
    author_name: oembed?.authorName ?? null,
    author_url: oembed?.authorUrl ?? null,
    text: oembed ? extractTweetText(oembed.html) : fallbackMetadata?.title ?? null,
    has_media: Boolean(fallbackMetadata?.imageUrl),
    media_url: fallbackMetadata?.imageUrl ?? null,
    created_at: null,
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
    const metadata = await fetchLinkPreviewMetadata({
      fetcher,
      url: input.post.link_url,
    })
    if (!metadata.imageUrl && !metadata.title) {
      return "skipped:no_preview_metadata"
    }

    await updatePostLinkPreviewMetadata({
      client: input.client,
      postId: input.post.post_id,
      linkOgImageUrl: metadata.imageUrl,
      linkOgTitle: metadata.title,
      updatedAt: input.checkedAt,
    })
    return metadata.imageUrl ?? metadata.title
  }

  const result = target.provider === "x"
    ? await hydrateXPostEmbed({ ...input, fetcher, target })
    : await hydrateYouTubeVideoEmbed({ ...input, fetcher, target })
  await refreshPostEmbedsProjection({
    client: input.client,
    postId: input.post.post_id,
    updatedAt: input.checkedAt,
  })

  return result
}
