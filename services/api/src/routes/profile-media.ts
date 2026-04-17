import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import {
  assertProfileMediaObject,
  fetchProfileMedia,
  uploadProfileMedia,
  type ProfileMediaKind,
} from "../lib/auth/profile-media-service"
import { parseMediaUploadForm } from "./media-route-helpers"

const profileMedia = new Hono<AuthenticatedEnv>()

profileMedia.post("/", authenticate, async (c) => {
  const { file, kind } = await parseMediaUploadForm<ProfileMediaKind>({
    req: c.req,
    allowedKinds: ["avatar", "cover"],
    invalidPayloadMessage: "Invalid profile media payload",
    invalidKindMessage: "kind must be either avatar or cover",
  })

  const uploaded = await uploadProfileMedia({
    env: c.env,
    file,
    kind,
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
