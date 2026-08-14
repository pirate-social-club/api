export { makeId, nowIso } from "@pirate/api-shared"

export function envFlag(value: string | undefined, fallback = false): boolean {
  if (value == null || value.trim() === "") return fallback
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

/**
 * The generic-goods flag gates writers only. Upload, scanning, and already
 * published-asset reads keep their own policies and must not use this helper.
 */
export function genericDigitalGoodsEnabled(env: {
  GENERIC_DIGITAL_GOODS_ENABLED?: string
}): boolean {
  return envFlag(env.GENERIC_DIGITAL_GOODS_ENABLED, false)
}

export function isLocalEnvironment(environment: string | undefined): boolean {
  const normalized = String(environment || "").trim().toLowerCase()
  return normalized === "" || ["dev", "development", "local", "test"].includes(normalized)
}

export function isProductionEnv(env: { ENVIRONMENT?: string }): boolean {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "production"
}

export function splitCsv(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}
