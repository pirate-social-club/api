import { internalError } from "../errors"

const SESSION_ID = /^[a-zA-Z0-9_-]{1,100}$/

export const DANCE_ATTEMPT_MEDIA_PREFIX = "dance/attempt-media/"
export const DANCE_ATTEMPT_PLACEHOLDER_FILENAME = "pending.mp4"

export function danceAttemptPlaceholderObjectKey(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) {
    throw internalError("Dance attempt session id is invalid")
  }
  return `${DANCE_ATTEMPT_MEDIA_PREFIX}${sessionId}/${DANCE_ATTEMPT_PLACEHOLDER_FILENAME}`
}
