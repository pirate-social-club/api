import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { badRequestError, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityWriteClient } from "./community-read-access"
import {
  type EndaomentOrganizationSearchResult,
  communityMutationActorFromUserId,
  loadCommunityLocalSnapshot,
  loadCommunityProjection,
  normalizeDonationPolicyMode,
  parseCommunitySettingsJson,
  parseEndaomentLookupTerm,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  selectEndaomentOrganizationMatch,
  type UpdateCommunityDonationPolicyRequestBody,
} from "./create/shared"
import type { Client } from "../sql-client"
import type {
  Community,
  Env,
} from "../../types"

type CommunityDonationSettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

/**
 * Write-only donation-policy mutation, isolated for buffer-safety testing. The
 * tx body issues ONLY writes (conditional INSERT donation_partners ON CONFLICT +
 * UPDATE communities) so it is safe inside the routed D1 buffering tx (flushed as
 * one atomic shard.batchWrite where reads are rejected). The settings read and
 * all resolution happen in the caller before this runs — no in-tx read.
 * See [d1-buffered-write-tx-select-trap].
 */
export async function updateCommunityDonationPolicyOnClient(
  client: Pick<Client, "transaction">,
  input: {
    communityId: string
    donationPolicyMode: ReturnType<typeof normalizeDonationPolicyMode>
    resolvedPartnerId: string | null
    partnerStatus: string
    donationPartner: NonNullable<UpdateCommunityDonationPolicyRequestBody["donation_partner"]> | null
    nextSettings: Record<string, unknown>
    now: string
  },
): Promise<void> {
  const tx = await client.transaction("write")
  try {
    if (input.resolvedPartnerId && input.donationPartner) {
      await tx.execute({
        sql: `
          INSERT INTO donation_partners (
            donation_partner_id, display_name, provider, provider_partner_ref,
            payout_destination_ref, image_url, review_status, status, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
          ON CONFLICT(donation_partner_id) DO UPDATE SET
            display_name = excluded.display_name,
            provider = excluded.provider,
            provider_partner_ref = excluded.provider_partner_ref,
            payout_destination_ref = excluded.payout_destination_ref,
            image_url = excluded.image_url,
            updated_at = excluded.updated_at
        `,
        args: [
          input.donationPartner.donation_partner_id.trim(),
          input.donationPartner.display_name.trim(),
          "endaoment",
          input.donationPartner.provider_partner_ref?.trim() || null,
          input.donationPartner.provider_partner_ref?.trim() || null,
          input.donationPartner.image_url?.trim() || null,
          "approved",
          "active",
          input.now,
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
      args: [
        input.communityId,
        input.donationPolicyMode,
        input.resolvedPartnerId,
        input.partnerStatus,
        JSON.stringify(input.nextSettings),
        input.now,
      ],
    })

    await tx.commit()
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[community-donation-settings] rollback failed while updating donation settings", rollbackError)
    }
    throw error
  } finally {
    tx.close()
  }
}

export async function resolveCommunityDonationPartner(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  endaomentUrl: string
  communityRepository: CommunityReadRepository
}): Promise<{
  donation_partner_id: string
  display_name: string
  provider: "endaoment"
  provider_partner_ref: string | null
  image_url: string | null
}> {
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.donation_partner_resolved",
  })
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

export async function updateCommunityDonationPolicy(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityDonationPolicyRequestBody
  communityRepository: CommunityDonationSettingsRepository
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

  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.donation_policy_updated",
  })
  // Routed through openCommunityWriteClient: when COMMUNITY_READ_ROUTING is off this is
  // legacy Turso; when on it follows the community's control_plane_routing backend (D1
  // or Turso fallback). The pre-tx settings read runs on the base client and the tx body
  // is write-only (INSERT donation_partners ON CONFLICT + UPDATE communities), so it is
  // D1-buffer-safe.
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
    const now = nowIso()
    const partnerStatus = donation_policy_mode === "none" ? "unconfigured" : "active"
    const resolvedPartnerId = donation_policy_mode === "none" ? null : (donation_partner_id ?? null)

    delete existingSettings.donation_partner
    const nextSettings = { ...existingSettings }

    await updateCommunityDonationPolicyOnClient(db.client, {
      communityId: input.communityId,
      donationPolicyMode: donation_policy_mode,
      resolvedPartnerId,
      partnerStatus,
      donationPartner: donation_partner ?? null,
      nextSettings,
      now,
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
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  communityRepository: CommunityDonationSettingsRepository
}): Promise<{
  community_id: string
  donation_policy_mode: string
  donation_partner_status: string
  donation_partner_id: string | null
  donation_partner: (NonNullable<Community["donation_partner"]> & { image_url?: string | null }) | null
  updated_at: string
}> {
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor ?? communityMutationActorFromUserId(input.userId ?? ""),
    action: "community.donation_policy_read",
  })
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
    donation_partner: partnerId && partner
      ? {
          donation_partner: partner.donation_partner_id,
          display_name: partner.display_name,
          provider: partner.provider,
          provider_partner_ref: partner.provider_partner_ref,
          image_url: partner.image_url,
          review_status: partner.review_status,
          status: partner.status,
        }
      : null,
    updated_at: updatedAt,
  }
}
