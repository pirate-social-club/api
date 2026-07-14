import { Hono } from "hono"
import type { Context } from "hono"
import {
  createSongArtifactUpload,
  fetchSongArtifactContent,
  uploadSongArtifactContent,
} from "../lib/song-artifacts/song-artifact-upload-service"
import {
  abortMultipartSongArtifactUpload,
  completeMultipartSongArtifactUpload,
  createMultipartSongArtifactUpload,
  mintSongArtifactPartSignedUrl,
} from "../lib/song-artifacts/song-artifact-upload-session-service"
import {
  createSongArtifactBundle,
  getSongArtifactBundleForCreator,
  listSongArtifactBundlesForCreator,
} from "../lib/song-artifacts/song-artifact-bundle-service"
import { requireScope, type AuthenticatedEnv } from "../lib/auth-middleware"
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
import {
  decodePublicSongArtifactBundleId,
  decodePublicSongArtifactUploadId,
  publicCommunityId,
} from "../lib/public-ids"
import { badRequestError } from "../lib/errors"
import {
  SUBMIT_TRACE_HEADER,
  submitTraceRequestFields,
  withSubmitTraceTiming,
} from "../lib/observability/submit-trace"

function getWaitUntil(c: Context<AuthenticatedEnv>): ((promise: Promise<void>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return undefined
  }
}

type CompleteSongArtifactMultipartUploadRequest = {
  upload_id: string
  parts: Array<{ part_number: number; etag: string }>
  content_hash?: string | null
}

const DEFAULT_SONG_ARTIFACT_LIST_LIMIT = 25
const MAX_SONG_ARTIFACT_LIST_LIMIT = 50

function songArtifactListLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SONG_ARTIFACT_LIST_LIMIT
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw badRequestError("Invalid limit")
  }
  return Math.min(parsed, MAX_SONG_ARTIFACT_LIST_LIMIT)
}

export function registerCommunitySongArtifactRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/song-artifact-uploads", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateSongArtifactUploadRequest>(c, "Invalid song artifact upload payload")

    const traceFields = {
      ...submitTraceRequestFields({
        contentLengthHeader: c.req.header("content-length"),
        sessionIdHeader: c.req.header("x-pirate-session-id"),
        submitTraceHeader: c.req.header(SUBMIT_TRACE_HEADER),
      }),
      artifact_kind: body.artifact_kind,
      community_id: publicCommunityId(communityId),
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
    }
    const result = await withSubmitTraceTiming("[create-post-submit] song artifact upload intent", traceFields, () => (
      body.upload_mode === "direct_multipart"
        ? createMultipartSongArtifactUpload({
          env: c.env,
          userId: actor.userId,
          communityId,
          body,
          communityRepository,
          origin: getRequestOrigin(c),
        })
        : createSongArtifactUpload({
          env: c.env,
          userId: actor.userId,
          communityId,
          body,
          communityRepository,
          origin: getRequestOrigin(c),
        })
    ))
    return c.json(result, 201)
  })

  communities.get("/:communityId/song-artifact-uploads/:songArtifactUploadId/sessions/:sessionId/parts/:partNumber/signed-url", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const partNumberParam = c.req.param("partNumber")
    if (!/^[1-9]\d*$/.test(partNumberParam)) {
      throw badRequestError("Invalid multipart part number")
    }
    const partNumber = Number.parseInt(partNumberParam, 10)
    if (!Number.isSafeInteger(partNumber)) {
      throw badRequestError("Invalid multipart part number")
    }
    const result = await mintSongArtifactPartSignedUrl({
      env: c.env,
      userId: actor.userId,
      communityId,
      songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
      sessionId: c.req.param("sessionId"),
      partNumber,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/song-artifact-uploads/:songArtifactUploadId/sessions/:sessionId/complete", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CompleteSongArtifactMultipartUploadRequest>(c, "Invalid multipart completion payload")
    if (!body.upload_id?.trim() || !Array.isArray(body.parts)) {
      throw badRequestError("Invalid multipart completion payload")
    }
    const result = await completeMultipartSongArtifactUpload({
      env: c.env,
      userId: actor.userId,
      communityId,
      songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
      sessionId: c.req.param("sessionId"),
      uploadId: body.upload_id,
      parts: body.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
      contentHash: body.content_hash,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/song-artifact-uploads/:songArtifactUploadId/sessions/:sessionId/abort", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    await abortMultipartSongArtifactUpload({
      env: c.env,
      userId: actor.userId,
      communityId,
      songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
      sessionId: c.req.param("sessionId"),
      reason: "user_cancelled",
      communityRepository,
    })
    return c.json({ object: "song_artifact_upload_session_abort", status: "aborted" }, 200)
  })

  communities.put("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const publicUploadId = c.req.param("songArtifactUploadId")
    const traceFields = {
      ...submitTraceRequestFields({
        contentLengthHeader: c.req.header("content-length"),
        sessionIdHeader: c.req.header("x-pirate-session-id"),
        submitTraceHeader: c.req.header(SUBMIT_TRACE_HEADER),
      }),
      community_id: publicCommunityId(communityId),
      song_artifact_upload_id: publicUploadId,
    }
    const result = await withSubmitTraceTiming("[create-post-submit] song artifact content upload", traceFields, async () => {
      const content = await readSongArtifactContent(c)
      return await uploadSongArtifactContent({
        env: c.env,
        userId: actor.userId,
        communityId,
        songArtifactUploadId: decodePublicSongArtifactUploadId(publicUploadId),
        content,
        communityRepository,
        origin: getRequestOrigin(c),
      })
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const publicUploadId = c.req.param("songArtifactUploadId")
    const traceFields = {
      ...submitTraceRequestFields({
        contentLengthHeader: c.req.header("content-length"),
        sessionIdHeader: c.req.header("x-pirate-session-id"),
        submitTraceHeader: c.req.header(SUBMIT_TRACE_HEADER),
      }),
      community_id: publicCommunityId(communityId),
      song_artifact_upload_id: publicUploadId,
    }
    const result = await withSubmitTraceTiming("[create-post-submit] song artifact content upload", traceFields, async () => {
      const content = await readSongArtifactContent(c)
      return await uploadSongArtifactContent({
        env: c.env,
        userId: actor.userId,
        communityId,
        songArtifactUploadId: decodePublicSongArtifactUploadId(publicUploadId),
        content,
        communityRepository,
        origin: getRequestOrigin(c),
      })
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const { communityId } = await getResolvedCommunityRouteContext(c)
    return await fetchSongArtifactContent({
      env: c.env,
      communityId,
      songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
      rangeHeader: c.req.header("range"),
    })
  })

  communities.on("HEAD", "/:communityId/song-artifact-uploads/:songArtifactUploadId/content", async (c) => {
    const { communityId } = await getResolvedCommunityRouteContext(c)
    const response = await fetchSongArtifactContent({
      env: c.env,
      communityId,
      songArtifactUploadId: decodePublicSongArtifactUploadId(c.req.param("songArtifactUploadId")),
      rangeHeader: c.req.header("range"),
    })
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    })
  })

  communities.post("/:communityId/song-artifacts", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateSongArtifactBundleRequest>(c, "Invalid song artifact bundle payload")

    const result = await createSongArtifactBundle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      waitUntil: getWaitUntil(c),
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/song-artifacts", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "song_artifacts:read")
    const result = await listSongArtifactBundlesForCreator({
      env: c.env,
      userId: actor.userId,
      communityId,
      query: c.req.query("q") ?? null,
      limit: songArtifactListLimit(c.req.query("limit")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/song-artifacts/:songArtifactBundleId", async (c) => {
    const { actor, communityId } = await getResolvedCommunityRouteContext(c)
    const result = await getSongArtifactBundleForCreator({
      env: c.env,
      userId: actor.userId,
      communityId,
      songArtifactBundleId: decodePublicSongArtifactBundleId(c.req.param("songArtifactBundleId")),
    })
    return c.json(result, 200)
  })
}
