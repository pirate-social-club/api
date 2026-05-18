import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { castPostVote, getPost } from "../lib/posts/post-service"
import { serializeLocalizedPostResponse } from "../serializers/post"
import { decodePublicPostId } from "../lib/public-ids"
import { writeAuditEventForEnv } from "../lib/audit"

const posts = new Hono<AuthenticatedEnv>()

posts.use("*", authenticateAdminOrUser)

posts.get("/:postId", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const result = await getPost({
    env: c.env,
    userId: actor.userId,
    postId: decodePublicPostId(c.req.param("postId")),
    locale: c.req.query("locale") ?? null,
    communityRepository,
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
  })
  return c.json(serializeLocalizedPostResponse(result), 200)
})

posts.post("/:postId/vote", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const body = await c.req.json<{ value?: number }>().catch(() => null)
  if (!body || (body.value !== -1 && body.value !== 1)) {
    throw badRequestError("Vote value must be -1 or 1")
  }

  const postId = decodePublicPostId(c.req.param("postId"))
  const result = await castPostVote({
    env: c.env,
    userId: actor.userId,
    postId,
    value: body.value,
    bypassVoterAccessChecks: actor.authType === "admin",
    communityRepository,
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "post_voted",
    userId: actor.userId,
    postId,
    properties: { value: result.value },
  })
  if (actor.authType === "admin") {
    const projection = await communityRepository.getCommunityPostProjectionByPostId(postId)
    await writeAuditEventForEnv(c.env, {
      action: "community.admin_post_vote_cast",
      actorId: actor.adminOverride.adminActorId,
      actorType: "operator",
      communityId: projection?.community_id ?? null,
      targetId: postId,
      targetType: "post",
      metadata: {
        acting_user_id: actor.userId,
        value: result.value,
      },
    })
  }
  return c.json(result, 200)
})

export default posts
