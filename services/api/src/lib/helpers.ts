import type { Env } from "../types"

export function nowIso(): string {
  return new Date().toISOString()
}

export function envFlag(value: string | undefined, fallback = false): boolean {
  if (value == null || value.trim() === "") return fallback
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

export function isLocalEnvironment(environment: string | undefined): boolean {
  const normalized = String(environment || "").trim().toLowerCase()
  return normalized === "" || ["dev", "development", "local", "test"].includes(normalized)
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

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}
