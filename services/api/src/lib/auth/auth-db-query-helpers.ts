import { executeFirst, type DbExecutor } from "../db-helpers"
import { internalError } from "../errors"
import type { InStatement } from "../sql-client"
import type { Env } from "../../types"

export function requireControlPlaneDbUrl(env: Env): string {
  const url = normalizeControlPlaneDbUrl(
    String(env.CONTROL_PLANE_DATABASE_URL || "").trim(),
  )
  if (!url) {
    throw internalError("CONTROL_PLANE_DATABASE_URL is not configured")
  }
  return url
}

const UNSUPPORTED_LIBSQL_URL_PARAMS = ["channel_binding", "sslmode"] as const

function isPostgresUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith("postgres://") || normalized.startsWith("postgresql://")
}

export function normalizeControlPlaneDbUrl(rawUrl: string): string {
  if (!rawUrl) {
    return rawUrl
  }

  if (isPostgresUrl(rawUrl)) {
    return rawUrl
  }

  const queryStart = rawUrl.indexOf("?")
  if (queryStart === -1) {
    return rawUrl
  }

  const hashStart = rawUrl.indexOf("#", queryStart)
  const base = rawUrl.slice(0, queryStart)
  const query = rawUrl.slice(queryStart + 1, hashStart === -1 ? rawUrl.length : hashStart)
  const hash = hashStart === -1 ? "" : rawUrl.slice(hashStart)
  const params = new URLSearchParams(query)
  const originalQuery = params.toString()

  for (const key of UNSUPPORTED_LIBSQL_URL_PARAMS) {
    params.delete(key)
  }

  const nextQuery = params.toString()
  if (nextQuery === originalQuery) {
    return rawUrl
  }

  return nextQuery ? `${base}?${nextQuery}${hash}` : `${base}${hash}`
}

function parseUniqueConstraintFields(error: unknown): string[] {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : ""
  if (code === "23505") {
    const detail = typeof error === "object" && error && "detail" in error
      ? String((error as { detail?: unknown }).detail || "")
      : ""
    const match = /Key \((.+)\)=/i.exec(detail)
    if (!match?.[1]) {
      return []
    }
    return match[1]
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean)
  }

  const message = error instanceof Error ? error.message : String(error)
  const match = /UNIQUE constraint failed: (.+)$/i.exec(message)
  if (!match?.[1]) {
    return []
  }
  return match[1]
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
}

export function hasUniqueConstraintField(error: unknown, field: string): boolean {
  return parseUniqueConstraintFields(error).includes(field)
}

export function hasUniqueConstraintName(error: unknown, constraintName: string): boolean {
  const exposedConstraint = typeof error === "object" && error && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint || "")
    : ""
  if (exposedConstraint === constraintName) {
    return true
  }

  const message = error instanceof Error ? error.message : String(error)
  return message.includes(`constraint "${constraintName}"`)
    || message.includes(`constraint '${constraintName}'`)
}

export function isMissingTableError(error: unknown, tableName: string): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : ""
  if (code === "42P01") {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("no such table") && message.includes(tableName)
}

export function isMissingColumnError(error: unknown, columnName: string): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : ""
  if (code === "42703") {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return (
    (message.includes("no such column") && message.includes(columnName))
    || message.includes(`column "${columnName}" does not exist`)
    || message.includes(`column '${columnName}' does not exist`)
  )
}

function isDuplicateColumnError(error: unknown, columnName: string): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : ""
  if (code === "42701") {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("duplicate column name") && message.includes(columnName)
}

export async function ensureProfilesPrimaryLinkedHandleColumn(executor: DbExecutor): Promise<void> {
  try {
    await executor.execute({
      sql: "SELECT primary_linked_handle_id FROM profiles LIMIT 0",
      args: [],
    })
    return
  } catch (error) {
    if (!isMissingColumnError(error, "primary_linked_handle_id")) {
      throw error
    }
  }

  try {
    await executor.execute("ALTER TABLE profiles ADD COLUMN primary_linked_handle_id TEXT")
  } catch (error) {
    if (isDuplicateColumnError(error, "primary_linked_handle_id")) {
      return
    }
    throw error
  }
}

async function ensureProfilesTextColumn(executor: DbExecutor, columnName: string): Promise<void> {
  try {
    await executor.execute({
      sql: `SELECT ${columnName} FROM profiles LIMIT 0`,
      args: [],
    })
    return
  } catch (error) {
    if (!isMissingColumnError(error, columnName)) {
      throw error
    }
  }

  try {
    await executor.execute(`ALTER TABLE profiles ADD COLUMN ${columnName} TEXT`)
  } catch (error) {
    if (isDuplicateColumnError(error, columnName)) {
      return
    }
    throw error
  }
}

export async function ensureProfilesSourceColumns(executor: DbExecutor): Promise<void> {
  await ensureProfilesTextColumn(executor, "avatar_source")
  await ensureProfilesTextColumn(executor, "cover_source")
  await ensureProfilesTextColumn(executor, "bio_source")
}

export async function ensureProfilesNationalityBadgeColumn(executor: DbExecutor): Promise<void> {
  try {
    await executor.execute({
      sql: "SELECT display_verified_nationality_badge FROM profiles LIMIT 0",
      args: [],
    })
    return
  } catch (error) {
    if (!isMissingColumnError(error, "display_verified_nationality_badge")) {
      throw error
    }
  }

  try {
    await executor.execute("ALTER TABLE profiles ADD COLUMN display_verified_nationality_badge INTEGER NOT NULL DEFAULT 0")
  } catch (error) {
    if (isDuplicateColumnError(error, "display_verified_nationality_badge")) {
      return
    }
    throw error
  }
}

export async function firstRow(executor: DbExecutor, stmt: InStatement): Promise<unknown | null> {
  return executeFirst(executor, stmt)
}
