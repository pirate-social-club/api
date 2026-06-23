import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { withTransaction } from "../transactions"
import { decodePublicId } from "../public-ids"
import { openCommunityWriteClient } from "./community-read-access"
import { listCommunityLabels, syncCommunityLabels } from "./community-label-store"
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
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)

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
      existingLinks
        .map((link) => [link.community_reference_link, link] as const)
        .filter(([linkId]) => typeof linkId === "string" && linkId.length > 0),
    )
    const now = nowIso()

    const referenceLinks = input.body.reference_links
      .map((link, index) => {
        const communityReferenceLinkId = link.id?.trim() || makeId("lnk")
        const existingLink = existingById.get(communityReferenceLinkId)
        const trimmedLabel = link.label?.trim() || null
        const trimmedUrl = link.url.trim()

        if (!trimmedUrl) {
          return null
        }

        return {
          community_reference_link: communityReferenceLinkId,
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
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)

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
        const definitionId = typeof definition.id === "string"
          ? definition.id
          : typeof definition.label_id === "string"
            ? definition.label_id
            : null
        if (!definitionId) {
          return []
        }

        return [[definitionId, definition] as const]
      }),
    )
    const now = nowIso()

    const definitions = input.body.definitions.map((definition, index) => {
      const labelId = definition.label_id?.trim()
        ? decodePublicId(definition.label_id, "cld")
        : makeId("lbl")
      const existingDefinition = existingDefinitionsById.get(labelId)

      return {
        id: labelId,
        object: "community_label_definition" as const,
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

    const storedDefinitions = definitions.map((definition) => ({
      label_id: definition.id,
      label: definition.label,
      description: definition.description,
      color_token: definition.color_token,
      status: definition.status,
      position: definition.position,
      allowed_post_types: definition.allowed_post_types,
    }))

    // Read existing labels BEFORE the tx — a buffered D1 write tx can't read them
    // back, and syncCommunityLabels needs them to preserve created_at/description
    // and to archive removed labels. The tx body below stays write-only.
    const existingLabels = await listCommunityLabels({
      executor: db.client,
      communityId: input.communityId,
      includeArchived: true,
    })

    const body = input.body
    await withTransaction(db.client, "write", async (tx) => {
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
            label_enabled: body.label_enabled,
            require_label_on_top_level_posts: body.require_label_on_top_level_posts,
            definitions: storedDefinitions,
          },
        }), now],
      })

      await syncCommunityLabels({
        executor: tx,
        communityId: input.communityId,
        existingLabels,
        definitions: definitions.map((definition) => ({
          label_id: definition.id,
          label: definition.label,
          description: definition.description,
          color_token: definition.color_token,
          status: definition.status,
        })),
        now,
      })
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
