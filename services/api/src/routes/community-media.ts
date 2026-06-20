import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import {
  assertCommunityMediaObject,
  fetchCommunityMedia,
  uploadCommunityMedia,
  type CommunityMediaKind,
} from "../lib/communities/community-media-service"
import {
  SUBMIT_TRACE_HEADER,
  submitTraceRequestFields,
  withSubmitTraceTiming,
} from "../lib/observability/submit-trace"
import { parseMediaUploadForm } from "./media-route-helpers"

const communityMedia = new Hono<AuthenticatedEnv>()

communityMedia.post("/", authenticate, async (c) => {
  const traceFields = submitTraceRequestFields({
    contentLengthHeader: c.req.header("content-length"),
    sessionIdHeader: c.req.header("x-pirate-session-id"),
    submitTraceHeader: c.req.header(SUBMIT_TRACE_HEADER),
  })
  const uploaded = await withSubmitTraceTiming("[create-post-submit] community media upload", traceFields, async () => {
    const { file, kind } = await parseMediaUploadForm<CommunityMediaKind>({
      req: c.req,
      allowedKinds: ["avatar", "banner", "post_image", "comment_image"],
      invalidPayloadMessage: "Invalid community media payload",
      invalidKindMessage: "kind must be avatar, banner, post_image, or comment_image",
    })

    console.info("[create-post-submit] community media upload:parsed", {
      ...traceFields,
      kind,
      mime_type: file.type,
      size_bytes: file.size,
    })
    return await uploadCommunityMedia({
      env: c.env,
      file,
      kind,
      origin: new URL(c.req.url).origin,
    })
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
