import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import {
  assertCommunityMediaObject,
  fetchCommunityMedia,
  uploadCommunityMedia,
  type CommunityMediaKind,
} from "../lib/communities/community-media-service"

const communityMedia = new Hono<AuthenticatedEnv>()

communityMedia.post("/", authenticate, async (c) => {
  const formData = await c.req.formData().catch(() => null)
  if (!formData) {
    throw badRequestError("Invalid community media payload")
  }

  const kindValue = typeof formData.get("kind") === "string"
    ? String(formData.get("kind")).trim()
    : ""
  const fileValue = formData.get("file")
  if (kindValue !== "avatar" && kindValue !== "banner") {
    throw badRequestError("kind must be either avatar or banner")
  }
  if (!(fileValue instanceof File)) {
    throw badRequestError("file is required")
  }

  const uploaded = await uploadCommunityMedia({
    env: c.env,
    file: fileValue,
    kind: kindValue as CommunityMediaKind,
    origin: new URL(c.req.url).origin,
  })

  return c.json(uploaded, 201)
})

communityMedia.get("/:kind/:objectName", async (c) => {
  const mediaObject = assertCommunityMediaObject({
    kind: c.req.param("kind"),
    objectName: c.req.param("objectName"),
  })
  return await fetchCommunityMedia({
    env: c.env,
    objectKey: mediaObject.objectKey,
  })
})

export default communityMedia
