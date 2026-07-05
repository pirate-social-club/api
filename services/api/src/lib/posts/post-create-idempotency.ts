import { sha256Hex } from "../crypto"
import type { CreatePostRequest } from "../../types"

function stableJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined
  }
  if (value == null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(stableJsonValue)
  }

  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (key === "agent_action_proof") {
      continue
    }
    const next = stableJsonValue(source[key])
    if (next !== undefined) {
      output[key] = next
    }
  }
  return output
}

export async function hashPostCreateRequestBody(body: CreatePostRequest): Promise<string> {
  return `0x${await sha256Hex(JSON.stringify(stableJsonValue(body)))}`
}

export function isPostCreateIdempotencyConflict(input: {
  existingBodyHash: string | null
  incomingBodyHash: string | null
  incomingPublishMode: CreatePostRequest["publish_mode"] | null | undefined
}): boolean {
  if (!input.incomingBodyHash || input.existingBodyHash === input.incomingBodyHash) {
    return false
  }
  if (!input.existingBodyHash && input.incomingPublishMode !== "async") {
    return false
  }
  return true
}
