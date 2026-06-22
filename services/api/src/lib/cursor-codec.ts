/**
 * Shared base64url + JSON transform for opaque list cursors.
 *
 * These cover only the encode/decode primitive — callers remain responsible
 * for validating the decoded payload's shape and for mapping malformed input
 * to the appropriate error (e.g. badRequestError).
 */

export function packCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

export function unpackCursor<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T
}
