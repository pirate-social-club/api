import { detectSupportedEmbedTarget } from "./embed-url-detection"
import { fetchLinkPreviewMetadata } from "./link-preview-fetcher"
import { upsertXPostEmbed, refreshPostEmbedsProjection } from "./post-embed-store"
import { updatePostLinkPreviewMetadata } from "./community-post-store"
import type { DbExecutor } from "../db-helpers"
import type { Post } from "../../types"

type XPostEmbed = NonNullable<Post["embeds"]>[number]

type XPostOEmbedResponse = {
  html?: unknown
  cache_age?: unknown
  author_name?: unknown
  author_url?: unknown
}

const X_OEMBED_TIMEOUT_MS = 8_000

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

function parseCacheAge(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function extractTweetText(html: string): string | null {
  const paragraphMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(html)
  const text = stripTags(paragraphMatch?.[1] ?? "")
  return text ? text.slice(0, 500) : null
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

  const oembed = await fetchXPostOEmbed({
    canonicalUrl: target.canonicalUrl,
    fetcher,
  })
  const fallbackMetadata = await fetchLinkPreviewMetadata({
    fetcher,
    url: target.canonicalUrl,
  })

  const preview: Extract<XPostEmbed, { provider: "x" }>["preview"] = {
    author_name: oembed?.authorName ?? null,
    author_url: oembed?.authorUrl ?? null,
    text: oembed ? extractTweetText(oembed.html) : fallbackMetadata?.title ?? null,
    has_media: Boolean(fallbackMetadata?.imageUrl),
    media_url: fallbackMetadata?.imageUrl ?? null,
    created_at: null,
  }
  const state: XPostEmbed["state"] = oembed ? "embed" : "unavailable"

  await upsertXPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: target.embedKey,
    providerRef: target.providerRef,
    canonicalUrl: target.canonicalUrl,
    originalUrl: target.originalUrl,
    state,
    preview,
    oembedHtml: oembed?.html ?? null,
    oembedCacheAge: oembed?.cacheAge ?? null,
    unavailableReason: state === "unavailable" ? "unknown" : null,
    checkedAt: input.checkedAt,
  })
  await refreshPostEmbedsProjection({
    client: input.client,
    postId: input.post.post_id,
    updatedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
    linkOgTitle: oembed ? preview.text ?? oembed.authorName : fallbackMetadata?.title ?? null,
    updatedAt: input.checkedAt,
  })

  return target.canonicalUrl
}
