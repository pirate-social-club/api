export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value)
}

export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

export function parseJsonArray<T = unknown>(value: unknown): T[] | null {
  if (value === null || value === undefined || value === "") return null
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed as T[] : null
  } catch {
    return null
  }
}

export function parseWeekdayJson(value: unknown): number[] | undefined {
  const arr = parseJsonArray<number>(value)
  return arr ?? undefined
}
