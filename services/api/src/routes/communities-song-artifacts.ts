import { Hono } from "hono"
import {
  createSongArtifactBundle,
  createSongArtifactUpload,
  fetchSongArtifactContent,
  getSongArtifactBundleForCreator,
  uploadSongArtifactContent,
} from "../lib/song-artifacts/song-artifact-service"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getResolvedCommunityRouteContext,
  getRequestOrigin,
  readSongArtifactContent,
  requireJsonBody,
} from "./communities-route-helpers"
import type {
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
} from "../types"

export function registerCommunitySongArtifactRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/song-artifact-uploads", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateSongArtifactUploadRequest>(c, "Invalid song artifact upload payload")

    const result = await createSongArtifactUpload({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      communityRepository,
      origin: getRequestOrigin(c),
    })
    return c.json(result, 201)
  })

  communities.put("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const content = await readSongArtifactContent(c)

    const result = await uploadSongArtifactContent({
      env: c.env,
      userId: actor.userId,
      communityId,
      songArtifactUploadId: c.req.param("songArtifactUploadId"),
      content,
      userRepository,
      communityRepository,
      origin: getRequestOrigin(c),
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const { communityId } = await getResolvedCommunityRouteContext(c)
    return await fetchSongArtifactContent({
      env: c.env,
      communityId,
      songArtifactUploadId: c.req.param("songArtifactUploadId"),
    })
  })

  communities.post("/:communityId/song-artifacts", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateSongArtifactBundleRequest>(c, "Invalid song artifact bundle payload")

    const result = await createSongArtifactBundle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/song-artifacts/:songArtifactBundleId", async (c) => {
    const { actor, communityId } = await getResolvedCommunityRouteContext(c)
    const result = await getSongArtifactBundleForCreator({
      env: c.env,
      userId: actor.userId,
      communityId,
      songArtifactBundleId: c.req.param("songArtifactBundleId"),
    })
    return c.json(result, 200)
  })
}
