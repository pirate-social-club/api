import { eligibilityFailed, internalError, providerUnavailable } from "../errors"
import { sha256Hex } from "../crypto"
import type { VerificationSessionRow } from "../auth/auth-db-rows"
import { VERY_UNIQUE_HUMAN_DOMAIN } from "./very-provider"

export type IdentityNullifierInput = {
  provider: "self" | "very"
  mechanism: "zk-nullifier" | "palm-nullifier"
  nullifierHash: string
}

function getRecordString(record: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function normalizeHashLike(value: string): string | null {
  const trimmed = value.trim()
  return /^[0-9a-f]{64}$/iu.test(trimmed) ? trimmed.toLowerCase() : null
}

export async function resolveIdentityNullifier(input: {
  row: VerificationSessionRow
  selfClaims?: { nullifier?: string | null } | null
  attestationData?: Record<string, unknown>
}): Promise<IdentityNullifierInput> {
  if (input.row.provider === "self") {
    const nullifier = input.selfClaims?.nullifier?.trim() ?? ""
    if (!nullifier) {
      throw providerUnavailable("Self verification did not return a stable nullifier")
    }
    return {
      provider: "self",
      mechanism: "zk-nullifier",
      nullifierHash: normalizeHashLike(nullifier) ?? await sha256Hex(`self:zk-nullifier:${nullifier}`),
    }
  }

  if (input.row.provider === "very") {
    const raw = getRecordString(input.attestationData, ["nullifier_hash", "nullifierHash", "nullifier"])
    if (!raw) {
      throw providerUnavailable("Very verification did not return a stable nullifier")
    }
    return {
      provider: "very",
      mechanism: "palm-nullifier",
      nullifierHash: normalizeHashLike(raw) ?? await sha256Hex(`${VERY_UNIQUE_HUMAN_DOMAIN}:palm-nullifier:${raw}`),
    }
  }

  throw internalError("Unsupported identity nullifier provider")
}

export async function assertIdentityNullifierAvailable(input: {
  activeNullifierUserId: string | null
  userId: string
}): Promise<void> {
  if (input.activeNullifierUserId && input.activeNullifierUserId !== input.userId) {
    throw eligibilityFailed("Identity proof is already linked to another user")
  }
}
