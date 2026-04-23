function trim(value: string | undefined): string {
  return String(value ?? "").trim()
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]"
}

function isLoopbackHttpUrl(value: string | undefined): boolean {
  const normalized = trim(value)
  if (!normalized) {
    return false
  }

  try {
    const url = new URL(normalized)
    return isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

async function canReachUrl(
  value: string,
  input?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  },
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort("timeout"), input?.timeoutMs ?? 750)

  try {
    await (input?.fetchImpl ?? fetch)(value, {
      method: "GET",
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function sanitizeLocalDevEnv(
  values: Record<string, string | undefined>,
  input?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  },
): Promise<{ values: Record<string, string | undefined>; warnings: string[] }> {
  const next = { ...values }
  const warnings: string[] = []
  const operatorBaseUrl = trim(next.COMMUNITY_PROVISION_OPERATOR_BASE_URL)

  if (!isLoopbackHttpUrl(operatorBaseUrl)) {
    return { values: next, warnings }
  }

  if (await canReachUrl(operatorBaseUrl, input)) {
    return { values: next, warnings }
  }

  next.COMMUNITY_PROVISION_OPERATOR_BASE_URL = ""
  next.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN = ""
  warnings.push(
    `COMMUNITY_PROVISION_OPERATOR_BASE_URL (${operatorBaseUrl}) is unreachable; falling back to local stub provisioning`,
  )
  return { values: next, warnings }
}
