import { conflictError } from "../errors"
import type { Post } from "../../types"

export const TELEGRAM_SYNTHETIC_TITLE_PREFIX =
  "Telegram channel synthetic telegram-channel-synthetic-"
export const TELEGRAM_SYNTHETIC_BODY =
  "Automated staging delivery check. This message should remove itself."
export const TELEGRAM_SYNTHETIC_MAX_AGE_MS = 60 * 60_000

/**
 * Prove that an operator-requested Telegram deletion belongs to a recent
 * synthetic run. Admin authentication alone is not sufficient authority to
 * delete an arbitrary bot-authored channel message.
 */
export function assertTelegramSyntheticCleanupPost(input: {
  post: Post | null
  communityId: string
  ownerUserId: string
  nowMs?: number
}): asserts input is typeof input & { post: Post } {
  const post = input.post
  const createdAtMs = Date.parse(post?.created_at ?? "")
  const ageMs = (input.nowMs ?? Date.now()) - createdAtMs
  if (
    !post
    || post.community_id !== input.communityId
    || post.author_user_id !== input.ownerUserId
    || post.status !== "published"
    || post.visibility !== "public"
    || !post.title?.startsWith(TELEGRAM_SYNTHETIC_TITLE_PREFIX)
    || post.body !== TELEGRAM_SYNTHETIC_BODY
    || !Number.isFinite(createdAtMs)
    || ageMs < -5 * 60_000
    || ageMs > TELEGRAM_SYNTHETIC_MAX_AGE_MS
  ) {
    throw conflictError("Telegram cleanup is restricted to a recent synthetic post")
  }
}
