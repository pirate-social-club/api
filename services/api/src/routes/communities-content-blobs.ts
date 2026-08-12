import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  createContentBlob,
  getOwnedContentBlob,
  uploadContentBlobBytes,
} from "../lib/content-blobs/content-blob-service"
import {
  CONTENT_BLOB_PROXY_MAX_BYTES,
  type CreateContentBlobRequest,
} from "../lib/content-blobs/content-blob-policy"
import { badRequestError } from "../lib/errors"
import {
  getRequestOrigin,
  getResolvedCommunityRouteContext,
  readUploadContent,
  requireJsonBody,
} from "./communities-route-helpers"

function contentBlobId(value: string): string {
  const normalized = value.trim()
  if (!/^cbl_[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw badRequestError("Invalid content blob id")
  }
  return normalized
}

function assertContentLengthWithinProxyLimit(
  value: string | undefined,
  contentType: string | undefined,
): void {
  if (!value?.trim()) return
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw badRequestError("Invalid Content-Length")
  }
  const isJson = contentType?.toLowerCase().includes("application/json") ?? false
  const requestLimit = isJson
    ? Math.ceil(CONTENT_BLOB_PROXY_MAX_BYTES * 4 / 3) + 4096
    : CONTENT_BLOB_PROXY_MAX_BYTES
  if (size > requestLimit) {
    throw badRequestError("Proxy content blobs are limited to 50 MiB")
  }
}

export function registerCommunityContentBlobRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/content-blobs", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateContentBlobRequest>(c, "Invalid content blob payload")
    const result = await createContentBlob({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      origin: getRequestOrigin(c),
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/content-blobs/:contentBlobId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getOwnedContentBlob({
      env: c.env,
      userId: actor.userId,
      communityId,
      contentBlobId: contentBlobId(c.req.param("contentBlobId")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/content-blobs/:contentBlobId/content", async (c) => {
    assertContentLengthWithinProxyLimit(
      c.req.header("content-length"),
      c.req.header("content-type"),
    )
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const content = await readUploadContent(c, "Content blob content is required")
    const result = await uploadContentBlobBytes({
      env: c.env,
      userId: actor.userId,
      communityId,
      contentBlobId: contentBlobId(c.req.param("contentBlobId")),
      content,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
