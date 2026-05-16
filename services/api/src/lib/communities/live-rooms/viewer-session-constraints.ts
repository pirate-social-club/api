const LIVE_ROOM_VIEWER_UID_INDEX = "idx_live_room_viewer_sessions_uid"
const LIVE_ROOM_VIEWER_UID_FIELDS = [
  "live_room_viewer_sessions.community_id",
  "live_room_viewer_sessions.live_room_id",
  "live_room_viewer_sessions.agora_uid",
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : ""
}

function exposedConstraint(error: unknown): string {
  return typeof error === "object" && error && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint || "")
    : ""
}

function uniqueConstraintFields(error: unknown): Set<string> {
  const message = errorMessage(error)
  const match = /UNIQUE constraint failed: (.+)$/i.exec(message)
  if (!match?.[1]) {
    return new Set()
  }
  return new Set(match[1]
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean))
}

function isUniqueConstraintError(error: unknown): boolean {
  const code = errorCode(error)
  const message = errorMessage(error)
  return code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || message.includes(`constraint "${LIVE_ROOM_VIEWER_UID_INDEX}"`)
    || message.includes(`constraint '${LIVE_ROOM_VIEWER_UID_INDEX}'`)
    || /^UNIQUE constraint failed:/i.test(message)
}

export function isLiveRoomViewerUidCollision(error: unknown): boolean {
  if (!isUniqueConstraintError(error)) {
    return false
  }
  if (exposedConstraint(error) === LIVE_ROOM_VIEWER_UID_INDEX) {
    return true
  }
  const fields = uniqueConstraintFields(error)
  return LIVE_ROOM_VIEWER_UID_FIELDS.every((field) => fields.has(field))
}
