import { internalError } from "./errors"

export function rowValue(row: unknown, key: string): unknown {
  if (!row || typeof row !== "object") return null
  return (row as Record<string, unknown>)[key]
}

export function stringOrNull(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export function jsonStringOrNull(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

export function requiredString(row: unknown, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) {
    throw internalError(`Missing required column ${key}`)
  }
  return value
}

export function requiredJsonString(row: unknown, key: string): string {
  const value = jsonStringOrNull(rowValue(row, key))
  if (!value) {
    throw internalError(`Missing required column ${key}`)
  }
  return value
}

export function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function requiredNumber(row: unknown, key: string): number {
  const value = numberOrNull(rowValue(row, key))
  if (value == null) {
    throw internalError(`Missing required numeric column ${key}`)
  }
  return value
}

export function boolOrNull(value: unknown): boolean | null {
  const numeric = numberOrNull(value)
  if (numeric == null) return null
  return Boolean(numeric)
}
