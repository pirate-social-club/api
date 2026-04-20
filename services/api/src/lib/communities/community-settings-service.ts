import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "./db-community-repository"
import { badRequestError, internalError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import { syncCommunityLabels } from "./community-label-store"
import {
  assertPublicV0GateConfiguration,
  assertUpdateCommunityGatesRequest,
  assertUpdateCommunityLabelPolicyRequest,
  assertUpdateCommunityReferenceLinksRequest,
  assertUpdateCommunitySafetyRequest,
  EndaomentOrganizationSearchResult,
  loadCommunityLocalSnapshot,
  loadCommunityProjection,
  normalizeDonationPolicyMode,
  normalizeInputRules,
  parseCommunitySettingsJson,
  parseEndaomentLookupTerm,
  requireOwnedCommunity,
  selectEndaomentOrganizationMatch,
  type UpdateCommunityDonationPolicyRequestBody,
  type UpdateCommunityGatesRequestBody,
  type UpdateCommunityLabelPolicyRequestBody,
  type UpdateCommunityRequestBody,
  type UpdateCommunityReferenceLinksRequestBody,
  type UpdateCommunityRulesRequestBody,
  type UpdateCommunitySafetyRequestBody,
  assertUpdateCommunityRequest,
} from "./community-create-shared"
import type {
  Community,
  Env,
} from "../../types"

export async function resolveCommunityDonationPartner(input: {
  env: Env
  userId: string
  communityId: string
  endaomentUrl: string
  communityRepository: CommunityRepository
}): Promise<{
  donation_partner_id: string
  display_name: string
  provider: "endaoment"
  provider_partner_ref: string | null
  image_url: string | null
}> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const lookupTerm = parseEndaomentLookupTerm(input.endaomentUrl)
  if (!lookupTerm) {
    throw badRequestError("Enter a valid Endaoment organization URL.")
  }

  const endpoint = new URL("https://api.endaoment.org/v2/orgs/search")
  endpoint.searchParams.set("searchTerm", lookupTerm)
  endpoint.searchParams.set("count", "10")

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  }).catch((error: unknown) => {
    throw internalError(error instanceof Error ? error.message : "Failed to reach Endaoment.")
  })

  if (!response.ok) {
    throw internalError(`Endaoment lookup failed with status ${response.status}`)
  }

  const payload = await response.json().catch(() => null)
  if (!Array.isArray(payload)) {
    throw internalError("Endaoment lookup returned an invalid response.")
  }

  const organizations = payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return []
    }

    const record = entry as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.name !== "string") {
      return []
    }

    return [{
      id: record.id,
      ein: typeof record.ein === "string" ? record.ein : null,
      isCompliant: typeof record.isCompliant === "boolean" ? record.isCompliant : undefined,
      logo: typeof record.logo === "string" ? record.logo : null,
      name: record.name,
    } satisfies EndaomentOrganizationSearchResult]
  })

  const organization = selectEndaomentOrganizationMatch(organizations, lookupTerm)
  if (!organization) {
    throw notFoundError("This Endaoment organization was not found.")
  }
  if (organization.isCompliant === false) {
    throw badRequestError("This Endaoment organization is not available right now.")
  }

  return {
    donation_partner_id: `endaoment:${organization.id}`,
    display_name: organization.name,
    provider: "endaoment",
    provider_partner_ref: organization.ein ?? organization.id,
    image_url: organization.logo ?? null,
  }
}

export async function updateCommunityRules(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityRulesRequestBody
  communityRepository: CommunityRepository
}): Promise<Community> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const rules = normalizeInputRules(input.body.rules)
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          DELETE FROM community_rules
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })

      for (const [index, rule] of rules.entries()) {
        await tx.execute({
          sql: `
            INSERT INTO community_rules (
              rule_id, community_id, title, body, report_reason, position, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
            )
          `,
          args: [
            rule.rule_id,
            input.communityId,
            rule.title,
            rule.body,
            rule.report_reason,
            index,
            rule.status,
            now,
          ],
        })
      }

      await tx.execute({
        sql: `
          UPDATE communities
          SET updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [input.communityId, now],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
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

export async function updateCommunitySafety(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunitySafetyRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunitySafetyRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT display_name, description, avatar_ref, banner_ref, settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const now = nowIso()

    const settings = {
      ...existingSettings,
      adult_content_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.adult_content_policy,
      },
      graphic_content_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.graphic_content_policy,
      },
      civility_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.civility_policy,
      },
      openai_moderation_settings: input.body.openai_moderation_settings,
    }

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(settings), now],
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

export async function updateCommunityDonationPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityDonationPolicyRequestBody
  communityRepository: CommunityRepository
}): Promise<Community> {
  const { donation_partner, donation_partner_id } = input.body
  const donation_policy_mode = normalizeDonationPolicyMode(input.body.donation_policy_mode)
  if (donation_policy_mode !== "none" && !donation_partner_id?.trim()) {
    throw badRequestError("donation_partner_id is required when donation_policy_mode is not none")
  }
  if (donation_policy_mode === "none" && donation_partner_id) {
    throw badRequestError("donation_partner_id must be null when donation_policy_mode is none")
  }
  if (
    donation_policy_mode !== "none"
    && (
      !donation_partner
      || donation_partner.provider !== "endaoment"
      || donation_partner.donation_partner_id.trim() !== donation_partner_id?.trim()
      || !donation_partner.display_name.trim()
    )
  ) {
    throw badRequestError("Resolved donation partner details are required when donations are enabled")
  }

  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
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
    const now = nowIso()
    const partnerStatus = donation_policy_mode === "none" ? "unconfigured" : "active"
    const resolvedPartnerId = donation_policy_mode === "none" ? null : (donation_partner_id ?? null)

    delete existingSettings.donation_partner
    const nextSettings = { ...existingSettings }

    const tx = await db.client.transaction("write")
    try {
      if (resolvedPartnerId && donation_partner) {
        await tx.execute({
          sql: `
            INSERT INTO donation_partners (
              donation_partner_id, display_name, provider, provider_partner_ref,
              image_url, review_status, status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
            ON CONFLICT(donation_partner_id) DO UPDATE SET
              display_name = excluded.display_name,
              provider = excluded.provider,
              provider_partner_ref = excluded.provider_partner_ref,
              image_url = excluded.image_url,
              review_status = excluded.review_status,
              status = excluded.status,
              updated_at = excluded.updated_at
          `,
          args: [
            donation_partner.donation_partner_id.trim(),
            donation_partner.display_name.trim(),
            "endaoment",
            donation_partner.provider_partner_ref?.trim() || null,
            donation_partner.image_url?.trim() || null,
            "approved",
            "active",
            now,
          ],
        })
      }

      await tx.execute({
        sql: `
          UPDATE communities
          SET donation_policy_mode = ?2,
              donation_partner_id = ?3,
              donation_partner_status = ?4,
              settings_json = ?5,
              updated_at = ?6
          WHERE community_id = ?1
        `,
        args: [input.communityId, donation_policy_mode, resolvedPartnerId, partnerStatus, JSON.stringify(nextSettings), now],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
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

export async function updateCommunity(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunityRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
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
    const nextSettings: Record<string, unknown> = {
      ...existingSettings,
    }
    const nextDisplayName =
      "display_name" in input.body
        ? (input.body.display_name?.trim() || String(row?.display_name ?? ""))
        : String(row?.display_name ?? "")
    const nextDescription =
      "description" in input.body
        ? (input.body.description?.trim() || null)
        : (row?.description == null ? null : String(row.description))
    const nextAvatarRef =
      "avatar_ref" in input.body
        ? (input.body.avatar_ref?.trim() || null)
        : (row?.avatar_ref == null ? null : String(row.avatar_ref))
    const nextBannerRef =
      "banner_ref" in input.body
        ? (input.body.banner_ref?.trim() || null)
        : (row?.banner_ref == null ? null : String(row.banner_ref))

    if ("agent_posting_policy" in input.body) {
      nextSettings.agent_posting_policy = input.body.agent_posting_policy ?? null
    }
    if ("agent_posting_scope" in input.body) {
      nextSettings.agent_posting_scope = input.body.agent_posting_scope ?? null
    }
    if ("agent_daily_post_cap" in input.body) {
      nextSettings.agent_daily_post_cap = input.body.agent_daily_post_cap ?? null
    }
    if ("agent_daily_reply_cap" in input.body) {
      nextSettings.agent_daily_reply_cap = input.body.agent_daily_reply_cap ?? null
    }
    if ("human_verification_lane" in input.body) {
      nextSettings.human_verification_lane = input.body.human_verification_lane ?? null
    }
    if ("accepted_agent_ownership_providers" in input.body) {
      nextSettings.accepted_agent_ownership_providers = input.body.accepted_agent_ownership_providers == null
        ? null
        : [...new Set(input.body.accepted_agent_ownership_providers)]
    }

    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE communities
        SET display_name = ?2,
            description = ?3,
            avatar_ref = ?4,
            banner_ref = ?5,
            settings_json = ?6,
            updated_at = ?7
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        nextDisplayName,
        nextDescription,
        nextAvatarRef,
        nextBannerRef,
        JSON.stringify(nextSettings),
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

export async function getCommunityDonationPolicy(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<{
  community_id: string
  donation_policy_mode: string
  donation_partner_status: string
  donation_partner_id: string | null
  donation_partner: (NonNullable<Community["donation_partner"]> & { image_url?: string | null }) | null
  updated_at: string
}> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const local = await loadCommunityLocalSnapshot(input.env, input.communityRepository, input.communityId)
  const partner = local?.donation_partner

  const mode = normalizeDonationPolicyMode(local?.donation_policy_mode)
  const status = local?.donation_partner_status ?? "unconfigured"
  const partnerId = local?.donation_partner_id ?? null
  const updatedAt = local?.updated_at ?? new Date().toISOString()

  return {
    community_id: input.communityId,
    donation_policy_mode: mode,
    donation_partner_status: status === "inactive" ? "paused" : status,
    donation_partner_id: partnerId,
    donation_partner: partnerId && partner ? partner : null,
    updated_at: updatedAt,
  }
}

export async function updateCommunityReferenceLinks(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityReferenceLinksRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunityReferenceLinksRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
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
  userId: string
  communityId: string
  body: UpdateCommunityLabelPolicyRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunityLabelPolicyRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
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
      } catch {}
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

export async function updateCommunityGates(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityGatesRequestBody | null
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<Community> {
  assertUpdateCommunityGatesRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)

  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community gates update")
  }

  assertPublicV0GateConfiguration(input.body, {
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          UPDATE communities
          SET membership_mode = ?2,
              default_age_gate_policy = ?3,
              allow_anonymous_identity = ?4,
              anonymous_identity_scope = ?5,
              updated_at = ?6
          WHERE community_id = ?1
        `,
        args: [
          input.communityId,
          input.body.membership_mode,
          input.body.default_age_gate_policy ?? "none",
          input.body.allow_anonymous_identity ? 1 : 0,
          input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
          now,
        ],
      })

      await tx.execute({
        sql: `
          DELETE FROM community_gate_rules
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })

      for (const [index, rule] of (input.body.gate_rules ?? []).entries()) {
        const existingId = typeof rule.gate_rule_id === "string" && rule.gate_rule_id.trim().length > 0
          ? rule.gate_rule_id.trim()
          : null
        const gateRuleId = existingId ?? `grl_${input.communityId}_${index}_${nowIso().replace(/[^a-zA-Z0-9]/g, "")}_${index}`
        await tx.execute({
          sql: `
            INSERT INTO community_gate_rules (
              gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json,
              chain_namespace, gate_config_json, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6,
              ?7, ?8, 'active', ?9, ?9
            )
          `,
          args: [
            gateRuleId,
            input.communityId,
            rule.scope,
            rule.gate_family,
            rule.gate_type,
            rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null,
            rule.chain_namespace ?? null,
            rule.gate_config ? JSON.stringify(rule.gate_config) : null,
            now,
          ],
        })
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
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
