import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { castPostVote, getPost } from "../lib/posts/post-service"
import { makeId, nowIso } from "../lib/helpers"
import { getControlPlaneClient } from "../lib/runtime-deps"

const posts = new Hono<AuthenticatedEnv>()

posts.use("*", authenticateAdminOrUser)

posts.get("/:postId", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const result = await getPost({
    env: c.env,
    userId: actor.userId,
    postId: c.req.param("postId"),
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
})

posts.post("/:postId/vote", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const body = await c.req.json<{ value?: number }>().catch(() => null)
  if (!body || (body.value !== -1 && body.value !== 1)) {
    throw badRequestError("Vote value must be -1 or 1")
  }

  const result = await castPostVote({
    env: c.env,
    userId: actor.userId,
    postId: c.req.param("postId"),
    value: body.value,
    bypassVoterAccessChecks: actor.authType === "admin",
    userRepository: getUserRepository(c.env),
    communityRepository,
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "post_voted",
    userId: actor.userId,
    postId: result.post_id,
    properties: { value: result.value },
  })
  if (actor.authType === "admin") {
    const projection = await communityRepository.getCommunityPostProjectionByPostId(result.post_id)
    await getControlPlaneClient(c.env).execute({
      sql: `
        INSERT INTO audit_log (
          audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
        ) VALUES (
          ?1, 'operator', ?2, 'community.admin_post_vote_cast', 'post', ?3, ?4, ?5, ?6
        )
      `,
      args: [
        makeId("aud"),
        actor.adminOverride.adminActorId,
        result.post_id,
        projection?.community_id ?? null,
        JSON.stringify({
          acting_user_id: actor.userId,
          value: result.value,
        }),
        nowIso(),
      ],
    })
  }
  return c.json(result, 200)
})

export default posts
