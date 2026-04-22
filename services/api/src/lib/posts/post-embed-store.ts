import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Post } from "../../types"

type PostEmbed = NonNullable<Post["embeds"]>[number]
type XPostEmbed = Extract<PostEmbed, { provider: "x" }>

type PostEmbedRow = {
  embed_id: string
  embed_key: string
  provider: "x"
  provider_ref: string | null
  canonical_url: string
  original_url: string
  state: XPostEmbed["state"]
  preview_json: string | null
  oembed_html: string | null
  oembed_cache_age: number | null
  unavailable_reason: XPostEmbed["unavailable_reason"]
  last_checked_at: string | null
}

function parseXPreview(value: string | null): XPostEmbed["preview"] {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as XPostEmbed["preview"]
      : null
  } catch {
    return null
  }
}

function toPostEmbed(row: PostEmbedRow): PostEmbed {
  return {
    embed_id: row.embed_id,
    embed_key: row.embed_key,
    provider: row.provider,
    provider_ref: row.provider_ref,
    canonical_url: row.canonical_url,
    original_url: row.original_url,
    state: row.state,
    preview: parseXPreview(row.preview_json),
    oembed_html: row.oembed_html,
    oembed_cache_age: row.oembed_cache_age,
    unavailable_reason: row.unavailable_reason,
    last_checked_at: row.last_checked_at,
  }
}

function toPostEmbedRow(row: unknown): PostEmbedRow {
  return {
    embed_id: requiredString(row, "embed_id"),
    embed_key: requiredString(row, "embed_key"),
    provider: requiredString(row, "provider") as "x",
    provider_ref: stringOrNull(rowValue(row, "provider_ref")),
    canonical_url: requiredString(row, "canonical_url"),
    original_url: requiredString(row, "original_url"),
    state: requiredString(row, "state") as XPostEmbed["state"],
    preview_json: stringOrNull(rowValue(row, "preview_json")),
    oembed_html: stringOrNull(rowValue(row, "oembed_html")),
    oembed_cache_age: numberOrNull(rowValue(row, "oembed_cache_age")),
    unavailable_reason: stringOrNull(rowValue(row, "unavailable_reason")) as XPostEmbed["unavailable_reason"],
    last_checked_at: stringOrNull(rowValue(row, "last_checked_at")),
  }
}

export async function upsertXPostEmbed(input: {
  client: DbExecutor
  communityId: string
  postId: string
  embedKey: string
  providerRef: string
  canonicalUrl: string
  originalUrl: string
  state: XPostEmbed["state"]
  preview: XPostEmbed["preview"]
  oembedHtml: string | null
  oembedCacheAge: number | null
  unavailableReason: XPostEmbed["unavailable_reason"]
  checkedAt: string
}): Promise<PostEmbed> {
  const embedId = makeId("emb")
  await input.client.execute({
    sql: `
      INSERT INTO post_embeds (
        embed_id, embed_key, post_id, community_id, provider, provider_ref, canonical_url, original_url,
        state, preview_json, oembed_html, oembed_cache_age, unavailable_reason, last_checked_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'x', ?5, ?6, ?7,
        ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?13
      )
      ON CONFLICT(embed_key) DO UPDATE SET
        post_id = excluded.post_id,
        community_id = excluded.community_id,
        provider_ref = excluded.provider_ref,
        canonical_url = excluded.canonical_url,
        original_url = excluded.original_url,
        state = excluded.state,
        preview_json = excluded.preview_json,
        oembed_html = excluded.oembed_html,
        oembed_cache_age = excluded.oembed_cache_age,
        unavailable_reason = excluded.unavailable_reason,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at
    `,
    args: [
      embedId,
      input.embedKey,
      input.postId,
      input.communityId,
      input.providerRef,
      input.canonicalUrl,
      input.originalUrl,
      input.state,
      input.preview ? JSON.stringify(input.preview) : null,
      input.oembedHtml,
      input.oembedCacheAge,
      input.unavailableReason ?? null,
      input.checkedAt,
    ],
  })

  const row = await executeFirst(input.client, {
    sql: `
      SELECT embed_id, embed_key, provider, provider_ref, canonical_url, original_url, state, preview_json,
             oembed_html, oembed_cache_age, unavailable_reason, last_checked_at
      FROM post_embeds
      WHERE embed_key = ?1
      LIMIT 1
    `,
    args: [input.embedKey],
  })

  if (!row) {
    throw new Error("Post embed is missing after upsert")
  }

  return toPostEmbed(toPostEmbedRow(row))
}

export async function listPostEmbeds(input: {
  client: DbExecutor
  postId: string
}): Promise<Post["embeds"]> {
  const result = await input.client.execute({
    sql: `
      SELECT embed_id, embed_key, provider, provider_ref, canonical_url, original_url, state, preview_json,
             oembed_html, oembed_cache_age, unavailable_reason, last_checked_at
      FROM post_embeds
      WHERE post_id = ?1
      ORDER BY created_at ASC, embed_id ASC
    `,
    args: [input.postId],
  })

  const embeds = result.rows.map((row) => toPostEmbed(toPostEmbedRow(row)))
  return embeds.length ? embeds : undefined
}

export async function refreshPostEmbedsProjection(input: {
  client: DbExecutor
  postId: string
  updatedAt: string
}): Promise<Post["embeds"]> {
  const embeds = await listPostEmbeds({
    client: input.client,
    postId: input.postId,
  })

  await input.client.execute({
    sql: `
      UPDATE posts
      SET embeds_json = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [
      input.postId,
      embeds?.length ? JSON.stringify(embeds) : null,
      input.updatedAt,
    ],
  })

  return embeds
}
