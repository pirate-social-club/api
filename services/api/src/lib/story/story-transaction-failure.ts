export type StoryTransactionFailureDisposition =
  | "retryable_prebroadcast"
  | "terminal_prebroadcast"
  | "ambiguous"

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (typeof current !== "object") break
    const value = current as Record<string, unknown>
    chain.push(value)
    current = value.cause
  }
  return chain
}

export function storyTransactionHashFromError(error: unknown): string | null {
  for (const value of errorChain(error)) {
    if (typeof value.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.transactionHash)) {
      return value.transactionHash
    }
  }
  return null
}

function errorText(chain: Array<Record<string, unknown>>): string {
  const parts: string[] = []
  for (const error of chain) {
    for (const field of ["name", "message", "shortMessage", "details"] as const) {
      if (typeof error[field] === "string") parts.push(error[field])
    }
    if (Array.isArray(error.metaMessages)) {
      parts.push(...error.metaMessages.filter((message): message is string => typeof message === "string"))
    }
  }
  return parts.join(" | ")
}

function hasPrebroadcastStageEvidence(chain: Array<Record<string, unknown>>, text: string): boolean {
  if (chain.some((error) => (
    error.name === "CallExecutionError" || error.name === "EstimateGasExecutionError"
  ))) return true

  return /["']method["']\s*:\s*["'](?:eth_call|eth_estimateGas|eth_fillTransaction)["']/i.test(text)
}

export function classifyStoryTransactionFailure(error: unknown): StoryTransactionFailureDisposition {
  const chain = errorChain(error)
  const text = errorText(chain)
  if (storyTransactionHashFromError(error)) return "ambiguous"
  if (chain.some((entry) => (
    entry.name === "TransactionExecutionError"
    || entry.name === "WaitForTransactionReceiptTimeoutError"
    || entry.name === "TransactionReceiptNotFoundError"
  ))) return "ambiguous"
  if (/eth_sendRawTransaction|eth_sendTransaction/i.test(text)) return "ambiguous"
  if (!hasPrebroadcastStageEvidence(chain, text)) return "ambiguous"

  const transient = /RPC Request failed|HTTP request failed|fetch failed|Failed to fetch|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|\b(?:429|500|502|503|504)\b|rate.?limit|InternalRpcError|took too long|network error/i.test(text)
  return transient ? "retryable_prebroadcast" : "terminal_prebroadcast"
}
