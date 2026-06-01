import { openCommunityDb } from "../communities/community-db-factory"
import type { CommunityDatabaseBindingRepository } from "../communities/db-community-repository"
import { badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import type { Env } from "../../env"
import type { Post } from "../../types"
import { updatePostLinkPreviewMetadata } from "./community-post-link-preview-store"
import { getPostById } from "./community-post-query-store"
import { upsertLinkEnrichment } from "./link-enrichment/repository"
import { normalizeLinkUrl } from "./link-enrichment/url-normalization"

export type LinkPreviewOverrideRequest = {
  image_url?: string | null
  title?: string | null
}

export type AdminLinkPreviewOverrideResult = {
  post: Post
  title: string
  imageUrl: string
}

function requirePreviewTitle(value: string | null | undefined): string {
  const title = String(value ?? "").trim()
  if (!title) {
    throw badRequestError("title is required")
  }
  return title.slice(0, 300)
}

function requireHttpsImageUrl(value: string | null | undefined): string {
  const imageUrl = String(value ?? "").trim()
  if (!imageUrl) {
    throw badRequestError("image_url is required")
  }

  let parsed: URL
  try {
    parsed = new URL(imageUrl)
  } catch {
    throw badRequestError("image_url must be a valid HTTPS URL")
  }
  if (parsed.protocol !== "https:") {
    throw badRequestError("image_url must be a valid HTTPS URL")
  }
  return parsed.href
}

function buildManualLinkEnrichmentSnapshot(input: {
  normalizedUrl: string
  canonicalUrl: string | null
  title: string
  imageUrl: string
  sourceLanguage: string | null
  fetchedAt: string
}): string {
  return JSON.stringify({
    version: 1,
    provider: "manual",
    status: "ready",
    normalized_url: input.normalizedUrl,
    canonical_url: input.canonicalUrl,
    title: input.title,
    description: null,
    source_language: input.sourceLanguage,
    publisher: null,
    image_url: input.imageUrl,
    summary: {
      status: null,
      short_summary: null,
      key_points: [],
      generated_at: null,
      model: null,
    },
    error: null,
    fetched_at: input.fetchedAt,
  })
}

export async function applyAdminLinkPreviewOverride(input: {
  env: Env
  communityRepository: CommunityDatabaseBindingRepository
  communityId: string
  postId: string
  body: LinkPreviewOverrideRequest
}): Promise<AdminLinkPreviewOverrideResult> {
  const title = requirePreviewTitle(input.body.title)
  const imageUrl = requireHttpsImageUrl(input.body.image_url)
  const updatedAt = nowIso()
  const sourceLanguage = null

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (post.post_type !== "link") {
      throw badRequestError("link preview can only be updated for link posts")
    }

    const normalizedUrl = post.link_url ? normalizeLinkUrl(post.link_url) : null
    const snapshot = normalizedUrl
      ? buildManualLinkEnrichmentSnapshot({
          normalizedUrl,
          canonicalUrl: post.link_url ?? null,
          title,
          imageUrl,
          sourceLanguage,
          fetchedAt: updatedAt,
        })
      : null

    await updatePostLinkPreviewMetadata({
      client: db.client,
      postId: input.postId,
      linkOgImageUrl: imageUrl,
      linkOgTitle: title,
      linkEnrichmentSnapshotJson: snapshot,
      linkEnrichmentSyncedAt: snapshot ? updatedAt : null,
      updatedAt,
    })

    if (normalizedUrl && input.env.CONTROL_PLANE_DATABASE_URL) {
      await upsertLinkEnrichment({
        client: getControlPlaneClient(input.env),
        normalizedUrl,
        canonicalUrl: post.link_url ?? normalizedUrl,
        provider: "manual",
        status: "ready",
        title,
        description: null,
        sourceLanguage,
        publisher: null,
        publishedAt: null,
        imageUrl,
        markdown: null,
        error: null,
        fetchedAt: updatedAt,
        now: updatedAt,
      })
    }

    const updated = await getPostById(db.client, input.postId)
    if (!updated) {
      throw notFoundError("Post not found")
    }
    return { post: updated, title, imageUrl }
  } finally {
    db.close()
  }
}
