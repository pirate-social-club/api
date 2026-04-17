import { Hono } from "hono"
import { getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { badRequestError } from "../lib/errors"
import {
  createSongArtifactBundle,
  createSongArtifactUpload,
  fetchSongArtifactContent,
  getSongArtifactBundleForCreator,
  uploadSongArtifactContent,
} from "../lib/song-artifacts/song-artifact-service"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import type {
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
} from "../types"

export function registerCommunitySongArtifactRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/song-artifact-uploads", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CreateSongArtifactUploadRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid song artifact upload payload")
    }

    const result = await createSongArtifactUpload({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      userRepository: getUserRepository(c.env),
      communityRepository: getCommunityRepository(c.env),
      origin: new URL(c.req.url).origin,
    })
    return c.json(result, 201)
  })

  communities.put("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const actor = c.get("actor")
    const contentType = String(c.req.header("content-type") || "").toLowerCase()
    let content: ArrayBuffer | null = null

    if (contentType.includes("application/json")) {
      const body = await c.req.json<{ content_base64?: string | null }>().catch(() => null)
      const contentBase64 = body?.content_base64?.trim()
      if (!contentBase64) {
        throw badRequestError("content_base64 is required")
      }
      try {
        const decoded = atob(contentBase64)
        const bytes = new Uint8Array(decoded.length)
        for (let index = 0; index < decoded.length; index += 1) {
          bytes[index] = decoded.charCodeAt(index)
        }
        content = bytes.buffer
      } catch {
        throw badRequestError("content_base64 must be valid base64")
      }
    } else {
      const raw = await c.req.arrayBuffer().catch(() => null)
      if (!raw || raw.byteLength === 0) {
        throw badRequestError("Song artifact content is required")
      }
      content = raw
    }

    const result = await uploadSongArtifactContent({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      songArtifactUploadId: c.req.param("songArtifactUploadId"),
      content,
      userRepository: getUserRepository(c.env),
      communityRepository: getCommunityRepository(c.env),
      origin: new URL(c.req.url).origin,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    return await fetchSongArtifactContent({
      env: c.env,
      communityId: c.req.param("communityId"),
      songArtifactUploadId: c.req.param("songArtifactUploadId"),
    })
  })

  communities.post("/:communityId/song-artifacts", async (c) => {
    const actor = c.get("actor")
    const body = await c.req.json<CreateSongArtifactBundleRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid song artifact bundle payload")
    }

    const result = await createSongArtifactBundle({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      body,
      userRepository: getUserRepository(c.env),
      communityRepository: getCommunityRepository(c.env),
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/song-artifacts/:songArtifactBundleId", async (c) => {
    const actor = c.get("actor")
    const result = await getSongArtifactBundleForCreator({
      env: c.env,
      userId: actor.userId,
      communityId: c.req.param("communityId"),
      songArtifactBundleId: c.req.param("songArtifactBundleId"),
    })
    return c.json(result, 200)
  })
}
