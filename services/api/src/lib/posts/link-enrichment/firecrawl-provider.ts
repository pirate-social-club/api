import type { Env } from "../../../env"

type FirecrawlMetadata = {
  title?: unknown
  description?: unknown
  language?: unknown
  ogTitle?: unknown
  ogDescription?: unknown
  ogUrl?: unknown
  ogImage?: unknown
  ogSiteName?: unknown
  sourceURL?: unknown
  statusCode?: unknown
  error?: unknown
  "article:published_time"?: unknown
  articlePublishedTime?: unknown
  publishedTime?: unknown
  publishTime?: unknown
  publishDate?: unknown
  publishedDate?: unknown
  datePublished?: unknown
  dcDate?: unknown
  DCDate?: unknown
}

type FirecrawlScrapeResponse = {
  success?: unknown
  data?: {
    markdown?: unknown
    metadata?: FirecrawlMetadata
  }
  error?: unknown
}

export type FirecrawlLinkEnrichmentResult = {
  ok: true
  canonicalUrl: string | null
  title: string | null
  description: string | null
  publisher: string | null
  publishedAt: string | null
  imageUrl: string | null
  markdown: string | null
} | {
  ok: false
  error: string
}

const FIRECRAWL_SCRAPE_TIMEOUT_MS = 15_000
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"

function cleanString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : ""
  return text || null
}

function cleanHttpsUrl(value: unknown): string | null {
  const text = cleanString(value)
  if (!text) {
    return null
  }
  try {
    const parsed = new URL(text)
    return parsed.protocol === "https:" ? parsed.href : null
  } catch {
    return null
  }
}

function statusCode(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanPublishedAt(metadata: FirecrawlMetadata | undefined): string | null {
  const raw = cleanString(metadata?.["article:published_time"])
    ?? cleanString(metadata?.articlePublishedTime)
    ?? cleanString(metadata?.publishedTime)
    ?? cleanString(metadata?.publishTime)
    ?? cleanString(metadata?.publishDate)
    ?? cleanString(metadata?.publishedDate)
    ?? cleanString(metadata?.datePublished)
    ?? cleanString(metadata?.dcDate)
    ?? cleanString(metadata?.DCDate)
  if (!raw) {
    return null
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return raw
  }
  return parsed.toISOString()
}

export async function fetchFirecrawlLinkEnrichment(input: {
  env: Env
  url: string
  fetcher?: typeof fetch
}): Promise<FirecrawlLinkEnrichmentResult | null> {
  const apiKey = input.env.FIRECRAWL_API_KEY?.trim()
  if (!apiKey) {
    return null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FIRECRAWL_SCRAPE_TIMEOUT_MS)
  try {
    const response = await (input.fetcher ?? fetch)(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: input.url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 172_800_000,
        blockAds: true,
        removeBase64Images: true,
        proxy: "auto",
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return {
        ok: false,
        error: `firecrawl:${response.status}`,
      }
    }

    const body = await response.json() as FirecrawlScrapeResponse
    if (body.success === false) {
      return {
        ok: false,
        error: `firecrawl:${cleanString(body.error) ?? "failed"}`,
      }
    }

    const metadata = body.data?.metadata
    if (metadata?.error) {
      return {
        ok: false,
        error: `firecrawl:${cleanString(metadata.error) ?? "metadata_error"}`,
      }
    }
    const observedStatus = statusCode(metadata?.statusCode)
    if (observedStatus != null && observedStatus >= 400) {
      return {
        ok: false,
        error: `firecrawl:source:${observedStatus}`,
      }
    }

    return {
      ok: true,
      canonicalUrl: cleanHttpsUrl(metadata?.ogUrl) ?? cleanHttpsUrl(metadata?.sourceURL),
      title: cleanString(metadata?.ogTitle) ?? cleanString(metadata?.title),
      description: cleanString(metadata?.ogDescription) ?? cleanString(metadata?.description),
      publisher: cleanString(metadata?.ogSiteName),
      publishedAt: cleanPublishedAt(metadata),
      imageUrl: cleanHttpsUrl(metadata?.ogImage),
      markdown: cleanString(body.data?.markdown),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.name === "AbortError"
        ? "firecrawl:timeout"
        : "firecrawl:fetch_failed",
    }
  } finally {
    clearTimeout(timeout)
  }
}
