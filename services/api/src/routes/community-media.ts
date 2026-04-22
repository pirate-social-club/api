import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import {
  assertCommunityMediaObject,
  fetchCommunityMedia,
  uploadCommunityMedia,
  type CommunityMediaKind,
} from "../lib/communities/community-media-service"
import { parseMediaUploadForm } from "./media-route-helpers"

const communityMedia = new Hono<AuthenticatedEnv>()

communityMedia.post("/", authenticate, async (c) => {
  const { file, kind } = await parseMediaUploadForm<CommunityMediaKind>({
    req: c.req,
    allowedKinds: ["avatar", "banner", "post_image"],
    invalidPayloadMessage: "Invalid community media payload",
    invalidKindMessage: "kind must be avatar, banner, or post_image",
  })

  const uploaded = await uploadCommunityMedia({
    env: c.env,
    file,
    kind,
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
