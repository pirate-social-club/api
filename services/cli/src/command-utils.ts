import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(resolve(filePath), "utf8")) as unknown
}

export function readJsonObject(filePath: string, label = "JSON file"): Record<string, unknown> {
  const parsed = readJsonFile(filePath)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function readOptionalTextFile(filePath: string | null): string | null {
  return filePath ? readFileSync(resolve(filePath), "utf8") : null
}

export function parseVoteValue(value: string): -1 | 1 {
  if (value === "1") return 1
  if (value === "-1") return -1
  throw new Error("--value must be 1 or -1")
}

export function requireAdminForActor(asUserId: string | null, sessionMode: string): void {
  if (asUserId && sessionMode !== "admin") {
    throw new Error("--as and --as-user-id require an admin session")
  }
}

export function stringField(item: Record<string, unknown>, field: string): string | null {
  const value = item[field]
  return typeof value === "string" && value.trim() ? value.trim() : null
}
