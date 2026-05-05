import type { Client, InStatement, Transaction } from "./sql-client"

export type DbExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

export async function executeFirst(executor: DbExecutor, stmt: InStatement): Promise<unknown | null> {
  const result = await executor.execute(stmt)
  return result.rows[0] ?? null
}

export function isMissingRelationError(error: unknown, relationName: string): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const record = error as Record<string, unknown>
  const code = typeof record.code === "string" ? record.code : ""
  const message = error instanceof Error ? error.message : String(record.message ?? "")
  const lowerMessage = message.toLowerCase()
  const lowerRelationName = relationName.toLowerCase()

  return code === "42P01"
    || (
      lowerMessage.includes(lowerRelationName)
      && (
        lowerMessage.includes("does not exist")
        || lowerMessage.includes("no such table")
      )
    )
}

const globalScope = globalThis as typeof globalThis & {
  __pirateSingletons?: Map<string, unknown>
}

function singletonMap(): Map<string, unknown> {
  if (!globalScope.__pirateSingletons) {
    globalScope.__pirateSingletons = new Map()
  }
  return globalScope.__pirateSingletons
}

export function globalSingleton<T>(name: string, cacheKey: string, factory: () => T): T {
  const map = singletonMap()
  const scopedKey = `${name}:${cacheKey}`
  const entry = map.get(scopedKey)
  if (entry) {
    return entry as T
  }
  const value = factory()
  map.set(scopedKey, value)
  return value
}
