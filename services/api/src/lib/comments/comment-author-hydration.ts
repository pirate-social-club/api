import type { CommentListItem } from "../../types"
import type { ProfileRepository } from "../auth/repositories"
import {
  hydratePublicHumanAuthorHandles,
  type AuthorHandleSurface,
} from "../identity/author-handle-hydration"

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
  surface?: AuthorHandleSurface,
): Promise<void> {
  await hydratePublicHumanAuthorHandles({
    authors: items.map((item) => item.comment),
    profileRepository,
    surface,
  })
}
