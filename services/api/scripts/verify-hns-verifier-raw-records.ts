type FetchLike = typeof fetch

type ProbeInput = {
  baseUrl: string
  authToken: string
  rootLabel: string
  fetchImpl?: FetchLike
  nowMs?: number
}

type ProbeFreshness = "fresh" | "stale" | "unknown"

type ProbeResult = {
  rootLabel: string
  rawRecordCount: number
  freshness: ProbeFreshness
  chainAnchorAgeSeconds: number | null
  verifierCommit: string | null
}

const STALE_CHAIN_AGE_SECONDS = 30 * 60

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function bodyPreview(body: string): string {
  return body.replace(/\s+/gu, " ").trim().slice(0, 500)
}

function httpFailureKind(status: number, body: string): "auth" | "upstream_rpc" | "http" {
  if (status === 401 || status === 403) return "auth"
  if (status === 429 || status === 502 || status === 503 || status === 504 || /\b(?:chain|upstream|rpc)\b/iu.test(body)) {
    return "upstream_rpc"
  }
  return "http"
}

function chainAnchorAgeSeconds(payload: {
  observed_at?: unknown
  chain_anchor?: { median_time?: unknown } | null
}, nowMs: number): number | null {
  const observedAt = typeof payload.observed_at === "string" ? Date.parse(payload.observed_at) : Number.NaN
  const medianTime = typeof payload.chain_anchor?.median_time === "number"
    ? payload.chain_anchor.median_time
    : typeof payload.chain_anchor?.median_time === "string"
      ? Number(payload.chain_anchor.median_time)
      : Number.NaN
  if (!Number.isFinite(observedAt) || !Number.isFinite(medianTime)) return null
  return Math.max(0, Math.round((nowMs - medianTime * 1_000) / 1_000))
}

export async function verifyHnsVerifierRawRecords(input: ProbeInput): Promise<ProbeResult> {
  const baseUrl = required(input.baseUrl, "HNS_VERIFIER_BASE_URL").replace(/\/+$/u, "")
  const authToken = required(input.authToken, "HNS_VERIFIER_AUTH_TOKEN")
  const rootLabel = required(input.rootLabel, "HNS_VERIFIER_CONTRACT_ROOT_LABEL")
  const url = new URL(`${baseUrl}/observe-root-parent`)
  url.searchParams.set("root_label", rootLabel)

  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${authToken}`,
        accept: "application/json",
      },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`HNS verifier contract probe [upstream_rpc] request failed: ${bodyPreview(detail)}`)
  }
  const responseBody = await response.text().catch(() => "")
  if (!response.ok) {
    const kind = httpFailureKind(response.status, responseBody)
    const detail = bodyPreview(responseBody)
    throw new Error(
      `HNS verifier contract probe [${kind}] failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  let payload: {
    root_label?: unknown
    parent?: { raw_records?: unknown } | null
    observed_at?: unknown
    chain_anchor?: { median_time?: unknown } | null
  }
  try {
    payload = JSON.parse(responseBody) as typeof payload
  } catch {
    throw new Error(`HNS verifier contract probe [shape] returned invalid JSON: ${bodyPreview(responseBody)}`)
  }
  if (payload.root_label !== rootLabel) {
    throw new Error(`HNS verifier contract probe [shape] returned a different root: ${String(payload.root_label)}`)
  }
  if (!Array.isArray(payload.parent?.raw_records)) {
    throw new Error("HNS verifier contract probe [shape] is missing parent.raw_records array")
  }

  const ageSeconds = chainAnchorAgeSeconds(payload, input.nowMs ?? Date.now())
  const freshness = ageSeconds == null
    ? "unknown"
    : ageSeconds > STALE_CHAIN_AGE_SECONDS
      ? "stale"
      : "fresh"
  if (freshness === "stale") {
    console.warn(JSON.stringify({
      event: "hns_verifier_contract_stale_observation",
      root_label: rootLabel,
      chain_anchor_age_seconds: ageSeconds,
      threshold_seconds: STALE_CHAIN_AGE_SECONDS,
    }))
  }

  return {
    rootLabel,
    rawRecordCount: payload.parent.raw_records.length,
    freshness,
    chainAnchorAgeSeconds: ageSeconds,
    verifierCommit: response.headers.get("x-verifier-commit"),
  }
}

if (import.meta.main) {
  const result = await verifyHnsVerifierRawRecords({
    baseUrl: process.env.HNS_VERIFIER_BASE_URL ?? "",
    authToken: process.env.HNS_VERIFIER_AUTH_TOKEN ?? "",
    rootLabel: process.env.HNS_VERIFIER_CONTRACT_ROOT_LABEL ?? "",
  })
  console.log(JSON.stringify({
    event: "hns_verifier_raw_record_contract_verified",
    root_label: result.rootLabel,
    raw_record_count: result.rawRecordCount,
    freshness: result.freshness,
    chain_anchor_age_seconds: result.chainAnchorAgeSeconds,
    verifier_commit: result.verifierCommit,
  }))
}
