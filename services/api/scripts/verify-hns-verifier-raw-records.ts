type FetchLike = typeof fetch

type ProbeInput = {
  baseUrl: string
  authToken: string
  rootLabel: string
  fetchImpl?: FetchLike
}

type ProbeResult = {
  rootLabel: string
  rawRecordCount: number
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

export async function verifyHnsVerifierRawRecords(input: ProbeInput): Promise<ProbeResult> {
  const baseUrl = required(input.baseUrl, "HNS_VERIFIER_BASE_URL").replace(/\/+$/u, "")
  const authToken = required(input.authToken, "HNS_VERIFIER_AUTH_TOKEN")
  const rootLabel = required(input.rootLabel, "HNS_VERIFIER_CONTRACT_ROOT_LABEL")
  const url = new URL(`${baseUrl}/observe-root-parent`)
  url.searchParams.set("root_label", rootLabel)

  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${authToken}`,
      accept: "application/json",
    },
  })
  if (!response.ok) {
    throw new Error(`HNS verifier contract probe failed with HTTP ${response.status}`)
  }

  const payload = await response.json() as {
    root_label?: unknown
    parent?: { raw_records?: unknown } | null
  }
  if (payload.root_label !== rootLabel) {
    throw new Error("HNS verifier contract probe returned a different root")
  }
  if (!Array.isArray(payload.parent?.raw_records)) {
    throw new Error("HNS verifier contract is missing parent.raw_records array")
  }

  return {
    rootLabel,
    rawRecordCount: payload.parent.raw_records.length,
  }
}

if (import.meta.main) {
  const result = await verifyHnsVerifierRawRecords({
    baseUrl: process.env.HNS_VERIFIER_BASE_URL ?? "",
    authToken: process.env.HNS_VERIFIER_AUTH_TOKEN ?? "",
    rootLabel: process.env.HNS_VERIFIER_CONTRACT_ROOT_LABEL ?? "",
  })
  console.log(`HNS verifier raw-record contract verified for ${result.rootLabel} (${result.rawRecordCount} records)`)
}
