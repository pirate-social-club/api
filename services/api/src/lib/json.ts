import { internalError } from "./errors"

export function parseJsonField<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw internalError("Corrupt JSON data", {
      field,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

export function parseOptionalJsonField<T>(raw: string | null | undefined, field: string): T | null {
  return raw ? parseJsonField<T>(raw, field) : null
}
