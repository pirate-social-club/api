import { badRequestError } from "../lib/errors"

export function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequestError(`Invalid ${field}`)
  }
  return value.trim()
}

export function requireTrimmedStringOrNull(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError(`Invalid ${field}`)
  }
  return value.trim()
}

export function optionalTrimmedString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError(`Invalid ${field}`)
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
