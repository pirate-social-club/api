import { internalError } from "../../errors"
import { nowIso } from "../../helpers"
import { logPipelineInfo } from "../../observability/pipeline-log"
import { getPostById } from "../../posts/community-post-query-store"
import { hydrateLinkPostEmbed } from "../../posts/embed-hydrator"
import { detectSupportedEmbedTarget } from "../../posts/embed-url-detection"
import { getControlPlaneClient } from "../../runtime-deps"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

type EmbedHydratePayload = {
  post_id?: string
  link_url?: string | null
}

export async function runEmbedHydrate(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<EmbedHydratePayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for embed hydration")
    }

    logPipelineInfo("[embed-hydrate] job starting", {
      job_id: input.job.job_id,
      community_id: input.job.community_id,
      post_id: postId,
      post_type: post.post_type,
      has_link_url: Boolean(post.link_url?.trim()),
      has_control_plane: Boolean(input.env.CONTROL_PLANE_DATABASE_URL),
      has_firecrawl_key: Boolean(input.env.FIRECRAWL_API_KEY?.trim()),
    })

    const resultRef = await hydrateLinkPostEmbed({
      client: db.client,
      controlPlaneClient: input.env.CONTROL_PLANE_DATABASE_URL ? getControlPlaneClient(input.env) : null,
      env: input.env,
      post: {
        ...post,
        link_url: post.link_url ?? payload?.link_url ?? null,
      },
      checkedAt: nowIso(),
    })

    const effectiveLinkUrl = post.link_url ?? payload?.link_url ?? null
    const isGenericLink = post.post_type === "link"
      && Boolean(effectiveLinkUrl?.trim())
      && !detectSupportedEmbedTarget(effectiveLinkUrl)
    const expectsControlPlaneEnrichment = Boolean(input.env.CONTROL_PLANE_DATABASE_URL)
    if (isGenericLink && expectsControlPlaneEnrichment && resultRef && !resultRef.startsWith("skipped:")) {
      const updated = await getPostById(db.client, postId)
      if (!updated?.link_enrichment_snapshot_json) {
        throw internalError("generic_link_enrichment_missing_snapshot")
      }
    }

    return resultRef
  } finally {
    db.close()
  }
}
