export type LinkPreviewMetadata = {
  imageUrl: string | null
  title: string | null
}

const LINK_PREVIEW_FETCH_TIMEOUT_MS = 8_000
const LINK_PREVIEW_FALLBACK_MAX_BYTES = 128 * 1024

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

function normalizePreviewTitle(value: string | null | undefined): string | null {
  const trimmed = decodeHtmlEntities(String(value ?? ""))
    .replace(/\s+/gu, " ")
    .trim()
  return trimmed ? trimmed.slice(0, 300) : null
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
    const response = await (input.fetcher ?? fetch)(pageUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": input.userAgent ?? "Pirate link preview fetcher",
      },
      redirect: "follow",
      signal: controller.signal,
    })

    if (!response.ok) {
      return { imageUrl: null, title: null }
    }

    return extractLinkPreviewMetadata({
      response,
      pageUrl: response.url || pageUrl,
    })
  } finally {
    clearTimeout(timeout)
  }
}
