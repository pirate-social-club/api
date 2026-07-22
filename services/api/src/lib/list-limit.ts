/**
 * Parses a `limit` query parameter into a page size.
 *
 * An absent parameter arrives as `null`/`undefined`/`""`. Callers used to write
 * `Number(value ?? "")` and test the result with `Number.isFinite`, but
 * `Number("")` is `0` — a finite value — so the intended default was never
 * applied and the clamp floored the page size to 1.
 */
export function parseListLimit(
  value: string | null | undefined,
  options: { fallback: number; max: number; min?: number },
): number {
  const min = options.min ?? 1
  const raw = (value ?? "").trim()
  if (raw === "") {
    return options.fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return options.fallback
  }
  return Math.min(options.max, Math.max(min, Math.trunc(parsed)))
}
