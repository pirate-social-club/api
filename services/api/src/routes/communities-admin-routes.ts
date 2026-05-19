import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { authError, badRequestError } from "../lib/errors"
import { migrateProvisionedCommunityDatabase } from "../lib/communities/provisioning/admin-migration-service"
import {
  getCommunitySongAcrPolicy,
  normalizeCommunitySongAcrPolicy,
  updateCommunitySongAcrPolicy,
} from "../lib/communities/community-song-acr-policy-service"
import {
  getCommunityCreationRouteContext,
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

function requireAdmin(c: Parameters<typeof getCommunityCreationRouteContext>[0]) {
  const { actor } = getCommunityCreationRouteContext(c)
  if (actor.authType !== "admin") {
    throw authError("Admin authentication required")
  }
  return actor
}

export function registerCommunityAdminRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/admin/health", async (c) => {
    const actor = requireAdmin(c)
    return c.json({
      ok: true,
      mode: "admin",
      admin_actor_id: actor.adminOverride.adminActorId,
      acting_user_id: actor.userId,
      scope: actor.adminOverride.scope,
    }, 200)
  })

  communities.post("/:communityId/admin/database-migrations", async (c) => {
    requireAdmin(c)
    const { communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await migrateProvisionedCommunityDatabase({
      env: c.env,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/admin/song-acr-policy", async (c) => {
    requireAdmin(c)
    const { communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const songAcrPolicy = await getCommunitySongAcrPolicy({
      env: c.env,
      communityId,
      communityRepository,
    })
    return c.json({
      community: `com_${communityId}`,
      song_acr_policy: songAcrPolicy,
    }, 200)
  })

  communities.post("/:communityId/admin/song-acr-policy", async (c) => {
    const actor = requireAdmin(c)
    const { communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ song_acr_policy?: unknown }>(c, "Invalid community song ACR policy payload")
    if (body.song_acr_policy !== "standard" && body.song_acr_policy !== "skip_for_trusted_uploaders") {
      throw badRequestError("Invalid community song ACR policy")
    }
    const community = await updateCommunitySongAcrPolicy({
      env: c.env,
      actor,
      communityId,
      songAcrPolicy: normalizeCommunitySongAcrPolicy(body.song_acr_policy),
      communityRepository,
    })
    return c.json({
      community,
      song_acr_policy: normalizeCommunitySongAcrPolicy(body.song_acr_policy),
    }, 200)
  })
}
