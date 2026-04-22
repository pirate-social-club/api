export type SupportedEmbedTarget = {
  provider: "x"
  providerRef: string
  embedKey: string
  canonicalUrl: string
  originalUrl: string
}

const X_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
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

export function detectSupportedEmbedTarget(linkUrl: string | null | undefined): SupportedEmbedTarget | null {
  const parsed = normalizeHttpUrl(linkUrl)
  if (!parsed) {
    return null
  }

  return detectXEmbed(parsed, String(linkUrl ?? "").trim())
}
