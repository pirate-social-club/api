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
export type SupportedEmbedTarget = XEmbedTarget | YouTubeEmbedTarget

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

export function detectSupportedEmbedTarget(linkUrl: string | null | undefined): SupportedEmbedTarget | null {
  const parsed = normalizeHttpUrl(linkUrl)
  if (!parsed) {
    return null
  }

  const originalUrl = String(linkUrl ?? "").trim()
  return detectXEmbed(parsed, originalUrl)
    ?? detectYouTubeEmbed(parsed, originalUrl)
}
