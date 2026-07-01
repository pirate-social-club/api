import type { CommentListItem } from "../../types"
import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import type { ProfileRepository } from "../auth/repositories"

/**
 * Resolves the read-time public handle label for public-identity human comment
 * authors and stamps it onto `item.comment.author_public_handle`, so clients
 * render the byline on first paint instead of doing a per-author profile
 * lookup. Anonymous, guest, and agent (`user_agent`) comments are left untouched
 * (byline comes from the anonymous label or the agent snapshot). One batched
 * profile lookup per call.
 */
export async function hydrateCommentAuthorPublicHandles(
  items: readonly CommentListItem[],
  profileRepository?: ProfileRepository | null,
): Promise<void> {
  if (!profileRepository) return

  const eligibleComments = items
    .map((item) => item.comment)
    .filter((comment): comment is CommentListItem["comment"] & { author_user_id: string } =>
      comment.identity_mode === "public"
      && comment.authorship_mode === "human_direct"
      && Boolean(comment.author_user_id))

  const authorUserIds = [...new Set(eligibleComments.map((comment) => comment.author_user_id))]
  if (authorUserIds.length === 0) return

  const profilesByUserId = profileRepository.listProfilesByUserIds
    ? await profileRepository.listProfilesByUserIds(authorUserIds).catch(() => new Map())
    : new Map(await Promise.all(authorUserIds.map(async (userId): Promise<[
        string,
        Awaited<ReturnType<ProfileRepository["getProfileByUserId"]>>,
      ]> => [
        userId,
        await profileRepository.getProfileByUserId(userId).catch(() => null),
      ])))

  for (const comment of eligibleComments) {
    const profile = profilesByUserId.get(comment.author_user_id) ?? null
    comment.author_public_handle = profile ? getProfilePublicHandleLabel(profile) : null
  }
}
