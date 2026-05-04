import { createHash } from "node:crypto"

export type PipelineLogFields = Record<string, unknown>

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()]+/giu
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function sanitizeLogText(value: unknown): string | null {
  const text = safeString(value)
  if (!text) {
    return null
  }
  return text
    .replace(URL_PATTERN, "[url]")
    .replace(EMAIL_PATTERN, "[email]")
    .slice(0, 240)
}

export function summarizeUrl(value: string | null | undefined): PipelineLogFields {
  const url = safeString(value)
  if (!url) {
    return {
      has_url: false,
    }
  }

  try {
    const parsed = new URL(url)
    return {
      has_url: true,
      url_scheme: parsed.protocol.replace(/:$/u, ""),
      url_host: parsed.hostname,
      url_path_hash: hashText(`${parsed.pathname}${parsed.search}`),
      url_hash: hashText(url),
    }
  } catch {
    return {
      has_url: true,
      url_hash: hashText(url),
    }
  }
}

function isSafeShortReference(value: string): boolean {
  return value.length <= 120
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("@")
    && !/\s/u.test(value)
}

export function summarizeReference(name: string, value: string | null | undefined): PipelineLogFields {
  const text = safeString(value)
  if (!text) {
    return {
      [`${name}_present`]: false,
    }
  }

  if (text.startsWith("http://") || text.startsWith("https://")) {
    const summary = summarizeUrl(text)
    return Object.fromEntries(
      Object.entries(summary).map(([key, summaryValue]) => [`${name}_${key}`, summaryValue]),
    )
  }

  if (isSafeShortReference(text)) {
    return {
      [name]: text,
    }
  }

  return {
    [`${name}_present`]: true,
    [`${name}_length`]: text.length,
    [`${name}_hash`]: hashText(text),
  }
}

function logFields(message: string, fields: PipelineLogFields): [string, PipelineLogFields] {
  return [message, fields]
}

export function logPipelineInfo(message: string, fields: PipelineLogFields): void {
  console.info(...logFields(message, fields))
}

export function logPipelineError(message: string, fields: PipelineLogFields): void {
  console.error(...logFields(message, fields))
}
