const TRACKING_PARAM_PREFIXES = ["utm_"]
const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
])

function shouldDropSearchParam(name: string): boolean {
  const normalized = name.toLowerCase()
  return TRACKING_PARAM_NAMES.has(normalized)
    || TRACKING_PARAM_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export function normalizeLinkUrl(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return null
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null
  }

  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase()
  parsed.hash = ""

  if (
    (parsed.protocol === "https:" && parsed.port === "443")
    || (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = ""
  }

  const keptParams = Array.from(parsed.searchParams.entries())
    .filter(([name]) => !shouldDropSearchParam(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameCompare = leftName.localeCompare(rightName)
      return nameCompare === 0 ? leftValue.localeCompare(rightValue) : nameCompare
    })
  parsed.search = ""
  for (const [name, value] of keptParams) {
    parsed.searchParams.append(name, value)
  }

  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "")
  }

  return parsed.href
}

