export type LinkPreviewMetadata = {
  imageUrl: string | null
}

const LINK_PREVIEW_FETCH_TIMEOUT_MS = 8_000
const LINK_PREVIEW_FALLBACK_MAX_BYTES = 128 * 1024

type MetaImageCandidate = {
  priority: number
  value: string
}

function normalizePreviewUrl(value: string | null | undefined, baseUrl: string): string | null {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = new URL(trimmed, baseUrl)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null
  } catch {
    return null
  }
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

async function extractOgImageWithHtmlRewriter(response: Response): Promise<string | null> {
  if (typeof HTMLRewriter === "undefined") {
    return null
  }

  let candidate: MetaImageCandidate | null = null
  const rewritten = new HTMLRewriter()
    .on("meta", {
      element(element) {
        const name = element.getAttribute("property") ?? element.getAttribute("name")
        candidate = chooseMetaImageCandidate(candidate, name, element.getAttribute("content"))
      },
    })
    .transform(response)

  await consumeRewrittenResponse(rewritten, () => Boolean(candidate && candidate.priority >= 2))
  const found = candidate as MetaImageCandidate | null
  return found?.value ?? null
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

async function extractOgImageWithBoundedText(response: Response): Promise<string | null> {
  const html = await readResponseTextLimit(response, LINK_PREVIEW_FALLBACK_MAX_BYTES)
  let candidate: MetaImageCandidate | null = null
  const metaTagPattern = /<meta\b[^>]*>/giu
  for (const match of html.matchAll(metaTagPattern)) {
    const tag = match[0]
    const name = readAttribute(tag, "property") ?? readAttribute(tag, "name")
    candidate = chooseMetaImageCandidate(candidate, name, readAttribute(tag, "content"))
    if (candidate?.priority && candidate.priority >= 2) {
      break
    }
  }
  return candidate?.value ?? null
}

export async function extractLinkPreviewMetadata(input: {
  response: Response
  pageUrl: string
}): Promise<LinkPreviewMetadata> {
  if (!canParseAsHtml(input.response)) {
    return { imageUrl: null }
  }

  const rawImageUrl = typeof HTMLRewriter === "undefined"
    ? await extractOgImageWithBoundedText(input.response)
    : await extractOgImageWithHtmlRewriter(input.response)

  return {
    imageUrl: normalizePreviewUrl(rawImageUrl, input.pageUrl),
  }
}

export async function fetchLinkPreviewMetadata(input: {
  url: string
  fetcher?: typeof fetch
  timeoutMs?: number
}): Promise<LinkPreviewMetadata> {
  const pageUrl = normalizePreviewUrl(input.url, input.url)
  if (!pageUrl) {
    return { imageUrl: null }
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? LINK_PREVIEW_FETCH_TIMEOUT_MS),
  )

  try {
    const response = await (input.fetcher ?? fetch)(pageUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Pirate link preview fetcher",
      },
      redirect: "follow",
      signal: controller.signal,
    })

    if (!response.ok) {
      return { imageUrl: null }
    }

    return extractLinkPreviewMetadata({
      response,
      pageUrl: response.url || pageUrl,
    })
  } finally {
    clearTimeout(timeout)
  }
}
