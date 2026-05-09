export function trim(value: string | null | undefined): string {
  return String(value ?? "").trim()
}

export function requireText(value: string | null | undefined, label: string): string {
  const normalized = trim(value)
  if (!normalized) {
    throw new Error(`${label} is required`)
  }
  return normalized
}

export function nowIso(date = new Date()): string {
  return date.toISOString()
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}
