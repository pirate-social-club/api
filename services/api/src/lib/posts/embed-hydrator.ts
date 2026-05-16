import { detectSupportedEmbedTarget } from "./embed-url-detection"
import {
  hydrateKalshiMarketEmbed,
  hydratePolymarketEventEmbed,
  hydratePolymarketMarketEmbed,
} from "./prediction-market-embed-hydrators"
import {
  hydrateXPostEmbed,
  hydrateYouTubeVideoEmbed,
} from "./social-video-embed-hydrators"
import type { LinkPostEmbedHydrationInput } from "./embed-hydration-types"
import { hydrateGenericLinkEnrichment } from "./link-enrichment/service"
import { refreshPostEmbedsProjection } from "./post-embed-store"

export async function hydrateLinkPostEmbed(input: LinkPostEmbedHydrationInput): Promise<string | null> {
  if (input.post.post_type !== "link" || !input.post.link_url?.trim()) {
    return "skipped:not_link_post"
  }

  const fetcher = input.fetcher ?? fetch
  const target = detectSupportedEmbedTarget(input.post.link_url)
  if (!target) {
    const resultRef = await hydrateGenericLinkEnrichment({
      communityClient: input.client,
      controlPlaneClient: input.controlPlaneClient,
      communityId: input.post.community_id,
      env: input.env,
      postId: input.post.post_id,
      url: input.post.link_url,
      checkedAt: input.checkedAt,
      fetcher,
    })
    if (!resultRef) {
      return "skipped:no_preview_metadata"
    }
    return resultRef
  }

  const result = target.provider === "x"
    ? await hydrateXPostEmbed({ ...input, fetcher, target })
    : target.provider === "youtube"
    ? await hydrateYouTubeVideoEmbed({ ...input, fetcher, target })
    : target.provider === "kalshi"
    ? await hydrateKalshiMarketEmbed({ ...input, fetcher, target })
    : target.isEventOnly
    ? await hydratePolymarketEventEmbed({ ...input, fetcher, target })
    : await hydratePolymarketMarketEmbed({ ...input, fetcher, target })
  await refreshPostEmbedsProjection({
    client: input.client,
    postId: input.post.post_id,
    updatedAt: input.checkedAt,
  })

  return result
}
