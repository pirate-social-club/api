/**
 * Cross-cutting helpers for normalizing environment-variable (and other
 * config) strings. Pure config plumbing — NOT request validation or SQL row
 * coercion, which have different failure semantics and live elsewhere.
 */

/** Trim a config value, treating null/undefined/blank as the empty string. */
export function trimEnv(value: string | null | undefined): string {
  return String(value ?? "").trim()
}

/** Trim a config value, returning null when it is null/undefined/blank. */
export function trimEnvOrNull(value: string | null | undefined): string | null {
  const trimmed = trimEnv(value)
  return trimmed ? trimmed : null
}
