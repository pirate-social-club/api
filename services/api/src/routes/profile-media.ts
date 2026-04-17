import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import {
  assertProfileMediaObject,
  fetchProfileMedia,
  uploadProfileMedia,
  type ProfileMediaKind,
} from "../lib/auth/profile-media-service"

const profileMedia = new Hono<AuthenticatedEnv>()

profileMedia.post("/", authenticate, async (c) => {
  const formData = await c.req.formData().catch(() => null)
  if (!formData) {
    throw badRequestError("Invalid profile media payload")
  }

  const kindValue = typeof formData.get("kind") === "string"
    ? String(formData.get("kind")).trim()
    : ""
  const fileValue = formData.get("file")
  if (kindValue !== "avatar" && kindValue !== "cover") {
    throw badRequestError("kind must be either avatar or cover")
  }
  if (!(fileValue instanceof File)) {
    throw badRequestError("file is required")
  }

  const uploaded = await uploadProfileMedia({
    env: c.env,
    file: fileValue,
    kind: kindValue as ProfileMediaKind,
    origin: new URL(c.req.url).origin,
  })

  return c.json(uploaded, 201)
})

profileMedia.get("/:kind/:objectName", async (c) => {
  const mediaObject = assertProfileMediaObject({
    kind: c.req.param("kind"),
    objectName: c.req.param("objectName"),
  })
  return await fetchProfileMedia({
    env: c.env,
    objectKey: mediaObject.objectKey,
  })
})

export default profileMedia
