export function unixSeconds(value: string | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Math.floor(timestamp / 1000)
}

export function nullableUnixSeconds(value: string | Date | null | undefined): number | null {
  return value == null ? null : unixSeconds(value)
}
