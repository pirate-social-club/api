import { badRequestError } from "./errors"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequestError(`${fieldName} is required`)
  }
}

export function assertNullableString(
  value: unknown,
  fieldName: string,
): asserts value is string | null | undefined {
  if (value != null && typeof value !== "string") {
    throw badRequestError(`${fieldName} must be a string or null`)
  }
}

export function assertNonNegativeNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw badRequestError(`${fieldName} must be a non-negative number`)
  }
}
