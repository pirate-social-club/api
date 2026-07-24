export function rotateCommunityJobTickIds(ids: string[], nowMs: number): string[] {
  if (ids.length <= 1) return ids
  const start = Math.floor(nowMs / 60_000) % ids.length
  return ids.slice(start).concat(ids.slice(0, start))
}
