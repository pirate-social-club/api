import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import { syncCommunityLabels } from "./community-label-store"
import {
  assertUpdateCommunityLabelPolicyRequest,
  assertUpdateCommunityReferenceLinksRequest,
  communityMutationActorFromUserId,
  loadCommunityProjection,
  parseCommunitySettingsJson,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  type UpdateCommunityLabelPolicyRequestBody,
  type UpdateCommunityReferenceLinksRequestBody,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

type CommunitySettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export async function updateCommunityReferenceLinks(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityReferenceLinksRequestBody | null
  communityRepository: CommunitySettingsRepository
}): Promise<Community> {
  assertUpdateCommunityReferenceLinksRequest(input.body)
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.reference_links_updated",
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const existingLinks = Array.isArray(existingSettings.reference_links)
      ? existingSettings.reference_links as NonNullable<Community["reference_links"]>
      : []
    const existingById = new Map(
      existingLinks.map((link) => [link.community_reference_link_id, link] as const),
    )
    const now = nowIso()

    const referenceLinks = input.body.reference_links
      .map((link, index) => {
        const communityReferenceLinkId = link.community_reference_link_id?.trim() || makeId("lnk")
        const existingLink = existingById.get(communityReferenceLinkId)
        const trimmedLabel = link.label?.trim() || null
        const trimmedUrl = link.url.trim()

        if (!trimmedUrl) {
          return null
        }

        return {
          community_reference_link_id: communityReferenceLinkId,
          platform: link.platform,
          url: trimmedUrl,
          label: trimmedLabel,
          link_status: "active" as const,
          verified: existingLink?.verified ?? false,
          metadata: {
            display_name: trimmedLabel,
            image_url: existingLink?.metadata.image_url ?? null,
          },
          position: typeof link.position === "number" ? link.position : index,
        } satisfies NonNullable<Community["reference_links"]>[number]
      })
      .filter((link) => link !== null) as NonNullable<Community["reference_links"]>

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        JSON.stringify({
          ...existingSettings,
          reference_links: referenceLinks,
        }),
        now,
      ],
    })
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function updateCommunityLabelPolicy(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityLabelPolicyRequestBody | null
  communityRepository: CommunitySettingsRepository
}): Promise<Community> {
  assertUpdateCommunityLabelPolicyRequest(input.body)
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.labels_updated",
  })
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const existingPolicy = existingSettings.label_policy && typeof existingSettings.label_policy === "object" && !Array.isArray(existingSettings.label_policy)
      ? existingSettings.label_policy as Record<string, unknown>
      : {}
    const existingDefinitions = Array.isArray(existingPolicy.definitions)
      ? existingPolicy.definitions as Array<Record<string, unknown>>
      : []
    const existingDefinitionsById = new Map(
      existingDefinitions.flatMap((definition) => {
        if (!definition || typeof definition.label_id !== "string") {
          return []
        }

        return [[definition.label_id, definition] as const]
      }),
    )
    const now = nowIso()

    const definitions = input.body.definitions.map((definition, index) => {
      const labelId = definition.label_id?.trim() || makeId("lbl")
      const existingDefinition = existingDefinitionsById.get(labelId)

      return {
        label_id: labelId,
        label: definition.label.trim(),
        description: typeof existingDefinition?.description === "string" ? existingDefinition.description : null,
        color_token: definition.color_token?.trim() || null,
        status: definition.status === "archived" ? "archived" : "active",
        position: index,
        allowed_post_types: Array.isArray(existingDefinition?.allowed_post_types)
          ? existingDefinition.allowed_post_types.filter((postType): postType is "text" | "image" | "video" | "song" =>
            postType === "text" || postType === "image" || postType === "video" || postType === "song")
          : null,
      } satisfies NonNullable<Community["label_policy"]>["definitions"][number]
    })

    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          UPDATE communities
          SET settings_json = ?2,
              updated_at = ?3
          WHERE community_id = ?1
        `,
        args: [input.communityId, JSON.stringify({
          ...existingSettings,
          label_policy: {
            label_enabled: input.body.label_enabled,
            require_label_on_top_level_posts: input.body.require_label_on_top_level_posts,
            definitions,
          },
        }), now],
      })

      await syncCommunityLabels({
        executor: tx,
        communityId: input.communityId,
        definitions: definitions.map((definition) => ({
          label_id: definition.label_id,
          label: definition.label,
          description: definition.description,
          color_token: definition.color_token,
          status: definition.status,
        })),
        now,
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[community-link-label-settings] rollback failed while updating link label settings", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}
