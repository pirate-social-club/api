export function parseJobPayload<T extends object>(raw: string | null): T | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as T : null
  } catch {
    return null
  }
}
