import { normalizeLinkTitle } from "./link-text"

export type LinkPreviewMetadata = {
  imageUrl: string | null
  title: string | null
}

const LINK_PREVIEW_FETCH_TIMEOUT_MS = 8_000
const LINK_PREVIEW_FALLBACK_MAX_BYTES = 128 * 1024
const LINK_PREVIEW_MAX_REDIRECTS = 4

type MetaImageCandidate = {
  priority: number
  value: string
}

type RawLinkPreviewMetadata = {
  imageUrl: string | null
  title: string | null
}

type MetaTitleCandidate = {
  priority: number
  value: string
}

// SSRF guard: reject hosts that are not safely public. Blocks literal private/
// reserved/loopback/link-local IPs (including the 169.254.169.254 cloud-metadata
// address), localhost, and single-label / *.local / *.internal names. NOTE: a
// Worker cannot resolve DNS before fetch, so a public hostname that *resolves* to
// a private IP (DNS rebinding) is not caught here — the durable fix is to route
// unfurling through the sandboxed third party. This closes the direct-literal and
// redirect-based vectors as defense-in-depth.
export function isBlockedSsrfHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (!host) return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const octets = v4.slice(1, 5).map((part) => Number(part))
    if (octets.some((n) => n > 255)) return true
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast / reserved
    return false
  }

  if (host.includes(":")) { // IPv6 literal
    if (host === "::1" || host === "::") return true
    if (host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return true
    if (host.startsWith("::ffff:")) return true // IPv4-mapped
    return false
  }

  if (host === "localhost") return true
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".intranet")) return true
  if (!host.includes(".")) return true // single-label host (e.g. "metadata", "router")
  return false
}

function normalizePreviewUrl(value: string | null | undefined, baseUrl: string): string | null {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = new URL(trimmed, baseUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }
    if (isBlockedSsrfHostname(parsed.hostname)) {
      return null
    }
    return parsed.href
  } catch {
    return null
  }
}

function normalizePreviewTitle(value: string | null | undefined): string | null {
  return normalizeLinkTitle(value)
}

function getMetaImagePriority(name: string | null | undefined): number {
  const normalized = String(name ?? "").trim().toLowerCase()
  if (normalized === "og:image:secure_url") {
    return 3
  }
  if (normalized === "og:image") {
    return 2
  }
  if (normalized === "twitter:image" || normalized === "twitter:image:src") {
    return 1
  }
  return 0
}

function getMetaTitlePriority(name: string | null | undefined): number {
  const normalized = String(name ?? "").trim().toLowerCase()
  if (normalized === "og:title") {
    return 3
  }
  if (normalized === "twitter:title") {
    return 2
  }
  return 0
}

function chooseMetaImageCandidate(
  current: MetaImageCandidate | null,
  name: string | null | undefined,
  content: string | null | undefined,
): MetaImageCandidate | null {
  const priority = getMetaImagePriority(name)
  const trimmed = String(content ?? "").trim()
  if (priority === 0 || !trimmed) {
    return current
  }
  if (!current || priority > current.priority) {
    return {
      priority,
      value: trimmed,
    }
  }
  return current
}

function chooseMetaTitleCandidate(
  current: MetaTitleCandidate | null,
  name: string | null | undefined,
  content: string | null | undefined,
): MetaTitleCandidate | null {
  const priority = getMetaTitlePriority(name)
  const title = normalizePreviewTitle(content)
  if (priority === 0 || !title) {
    return current
  }
  if (!current || priority > current.priority) {
    return {
      priority,
      value: title,
    }
  }
  return current
}

function canParseAsHtml(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  return !contentType || contentType.includes("html") || contentType.includes("xml")
}

async function consumeRewrittenResponse(response: Response, shouldStop: () => boolean): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    await response.arrayBuffer()
    return
  }

  try {
    while (true) {
      if (shouldStop()) {
        await reader.cancel()
        return
      }
      const { done } = await reader.read()
      if (done || shouldStop()) {
        if (!done && shouldStop()) {
          await reader.cancel()
        }
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function extractMetadataWithHtmlRewriter(response: Response): Promise<RawLinkPreviewMetadata | null> {
  if (typeof HTMLRewriter === "undefined") {
    return null
  }

  let imageCandidate: MetaImageCandidate | null = null
  let titleCandidate: MetaTitleCandidate | null = null
  let documentTitle = ""
  const rewritten = new HTMLRewriter()
    .on("meta", {
      element(element) {
        const name = element.getAttribute("property") ?? element.getAttribute("name")
        imageCandidate = chooseMetaImageCandidate(imageCandidate, name, element.getAttribute("content"))
        titleCandidate = chooseMetaTitleCandidate(titleCandidate, name, element.getAttribute("content"))
      },
    })
    .on("title", {
      text(text) {
        documentTitle += text.text
      },
    })
    .transform(response)

  await consumeRewrittenResponse(rewritten, () => Boolean(
    imageCandidate && imageCandidate.priority >= 2 && titleCandidate,
  ))
  const foundImage = imageCandidate as MetaImageCandidate | null
  const foundTitle = titleCandidate as MetaTitleCandidate | null
  return {
    imageUrl: foundImage?.value ?? null,
    title: foundTitle?.value ?? normalizePreviewTitle(documentTitle),
  }
}

async function readResponseTextLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    return response.text()
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done || !value) {
        break
      }
      const remaining = maxBytes - totalBytes
      const chunk = value.length > remaining ? value.slice(0, remaining) : value
      chunks.push(chunk)
      totalBytes += chunk.length
      if (value.length > remaining) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(combined)
}

function readAttribute(tag: string, attributeName: string): string | null {
  const pattern = new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "iu")
  const match = pattern.exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

async function extractMetadataWithBoundedText(response: Response): Promise<RawLinkPreviewMetadata> {
  const html = await readResponseTextLimit(response, LINK_PREVIEW_FALLBACK_MAX_BYTES)
  let imageCandidate: MetaImageCandidate | null = null
  let titleCandidate: MetaTitleCandidate | null = null
  const metaTagPattern = /<meta\b[^>]*>/giu
  for (const match of html.matchAll(metaTagPattern)) {
    const tag = match[0]
    const name = readAttribute(tag, "property") ?? readAttribute(tag, "name")
    imageCandidate = chooseMetaImageCandidate(imageCandidate, name, readAttribute(tag, "content"))
    titleCandidate = chooseMetaTitleCandidate(titleCandidate, name, readAttribute(tag, "content"))
    if (imageCandidate?.priority && imageCandidate.priority >= 2 && titleCandidate) {
      break
    }
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  return {
    imageUrl: imageCandidate?.value ?? null,
    title: titleCandidate?.value ?? normalizePreviewTitle(titleMatch?.[1]),
  }
}

export async function extractLinkPreviewMetadata(input: {
  response: Response
  pageUrl: string
}): Promise<LinkPreviewMetadata> {
  if (!canParseAsHtml(input.response)) {
    return { imageUrl: null, title: null }
  }

  const metadata = await extractMetadataWithHtmlRewriter(input.response)
    ?? await extractMetadataWithBoundedText(input.response)

  return {
    imageUrl: normalizePreviewUrl(metadata.imageUrl, input.pageUrl),
    title: metadata.title,
  }
}

export async function fetchLinkPreviewMetadata(input: {
  url: string
  fetcher?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}): Promise<LinkPreviewMetadata> {
  const pageUrl = normalizePreviewUrl(input.url, input.url)
  if (!pageUrl) {
    return { imageUrl: null, title: null }
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? LINK_PREVIEW_FETCH_TIMEOUT_MS),
  )

  try {
    const doFetch = input.fetcher ?? fetch
    const requestInit = {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": input.userAgent ?? "Pirate link preview fetcher",
      },
      // Follow redirects manually so every hop is re-checked against the SSRF guard
      // (a public host must not be able to 302 us to an internal target).
      redirect: "manual" as const,
      signal: controller.signal,
    }
    let currentUrl = pageUrl
    let response = await doFetch(currentUrl, requestInit)
    for (let hop = 0; hop < LINK_PREVIEW_MAX_REDIRECTS; hop++) {
      if (response.status < 300 || response.status >= 400) {
        break
      }
      const location = normalizePreviewUrl(response.headers.get("location"), currentUrl)
      if (!location) {
        return { imageUrl: null, title: null }
      }
      currentUrl = location
      response = await doFetch(currentUrl, requestInit)
    }

    if (!response.ok) {
      return { imageUrl: null, title: null }
    }

    return extractLinkPreviewMetadata({
      response,
      pageUrl: response.url || currentUrl,
    })
  } finally {
    clearTimeout(timeout)
  }
}
