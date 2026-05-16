import type { XEmbedTarget, YouTubeEmbedTarget } from "./embed-url-detection"
import type { ProviderEmbedHydrationInput } from "./embed-hydration-types"
import { fetchLinkPreviewMetadata } from "./link-preview-fetcher"
import {
  extractTweetMediaUrl,
  extractTweetText,
  fetchXPostOEmbed,
  fetchYouTubeOEmbed,
} from "./link-embed-preview"
import { upsertPostEmbed } from "./post-embed-store"
import { updatePostLinkPreviewMetadata } from "./community-post-link-preview-store"
import type { Post } from "../../types"

type PostEmbed = NonNullable<Post["embeds"]>[number]
type XPostEmbed = Extract<PostEmbed, { provider: "x" }>
type YouTubeVideoEmbed = Extract<PostEmbed, { provider: "youtube" }>

export async function hydrateXPostEmbed(
  input: ProviderEmbedHydrationInput<XEmbedTarget>,
): Promise<string | null> {
  const oembed = await fetchXPostOEmbed({
    canonicalUrl: input.target.canonicalUrl,
    fetcher: input.fetcher,
  })
  const fallbackMetadata = await fetchLinkPreviewMetadata({
    fetcher: input.fetcher,
    url: input.target.canonicalUrl,
    userAgent: "Twitterbot",
  })

  const extractedMediaUrl = oembed ? extractTweetMediaUrl(oembed.html) : null
  const preview: XPostEmbed["preview"] = {
    author_name: oembed?.authorName ?? null,
    author_url: oembed?.authorUrl ?? null,
    text: oembed ? extractTweetText(oembed.html) : fallbackMetadata?.title ?? null,
    has_media: Boolean(fallbackMetadata?.imageUrl || extractedMediaUrl),
    media_url: fallbackMetadata?.imageUrl ?? extractedMediaUrl ?? null,
    created: null,
  }
  const state: XPostEmbed["state"] = oembed ? "embed" : "unavailable"

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "x",
    providerRef: input.target.providerRef,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state,
    preview,
    oembedHtml: oembed?.html ?? null,
    oembedCacheAge: oembed?.cacheAge ?? null,
    unavailableReason: state === "unavailable" ? "unknown" : null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: fallbackMetadata?.imageUrl ?? null,
    linkOgTitle: oembed ? preview.text ?? oembed.authorName : fallbackMetadata?.title ?? null,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}

export async function hydrateYouTubeVideoEmbed(
  input: ProviderEmbedHydrationInput<YouTubeEmbedTarget>,
): Promise<string | null> {
  const oembed = await fetchYouTubeOEmbed({
    canonicalUrl: input.target.canonicalUrl,
    fetcher: input.fetcher,
    videoId: input.target.providerRef,
  })
  const fallbackMetadata = oembed
    ? null
    : await fetchLinkPreviewMetadata({
      fetcher: input.fetcher,
      url: input.target.canonicalUrl,
    })
  const preview: YouTubeVideoEmbed["preview"] = oembed?.preview ?? {
    title: fallbackMetadata?.title ?? null,
    author_name: null,
    author_url: null,
    thumbnail_url: fallbackMetadata?.imageUrl ?? null,
    thumbnail_width: null,
    thumbnail_height: null,
  }
  const state: YouTubeVideoEmbed["state"] = oembed ? "embed" : fallbackMetadata ? "preview" : "unavailable"

  await upsertPostEmbed({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    embedKey: input.target.embedKey,
    provider: "youtube",
    providerRef: input.target.providerRef,
    canonicalUrl: input.target.canonicalUrl,
    originalUrl: input.target.originalUrl,
    state,
    preview,
    oembedHtml: oembed?.html ?? null,
    oembedCacheAge: oembed?.cacheAge ?? null,
    unavailableReason: state === "unavailable" ? "unknown" : null,
    checkedAt: input.checkedAt,
  })

  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.post.post_id,
    linkOgImageUrl: preview?.thumbnail_url ?? null,
    linkOgTitle: preview?.title ?? null,
    updatedAt: input.checkedAt,
  })

  return input.target.canonicalUrl
}
