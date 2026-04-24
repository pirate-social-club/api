import {
  buildMembershipGateSummary,
  canAccessCommunity,
  getCommunityFollowStatus,
  getCommunityFollowerCount,
  getCommunityMemberCount,
  getCommunityMembershipState,
  listActiveMembershipGateRules,
} from "./membership/store"
import { openCommunityDb } from "./community-db-factory"
import {
  buildLocalizedCommunityPreview,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "../localization/community-localization-service"
import {
  resolveCommunityAvatarRef,
  resolveCommunityBannerRef,
} from "./community-identity-media"
import { parseStoredReferenceLinks } from "./community-serialization"
import type { CommunityRepository } from "./db-community-repository"
import { notFoundError } from "../errors"
import type {
  CommunityPreview,
  Env,
} from "../../types"

type CommunityPreviewRule = NonNullable<CommunityPreview["rules"]>[number]

function parsePreviewSettingsJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}

  return {}
}

export async function getCommunityPreview(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  communityRepository: CommunityRepository
}): Promise<CommunityPreview> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const followStatus = await getCommunityFollowStatus(db.client, input.communityId, input.userId)
    return await buildCommunityPreview({
      client: db.client,
      communityId: input.communityId,
      communityDisplayName: community.display_name,
      communityCreatedAt: community.created_at,
      locale: input.locale ?? null,
      gateRules: rules,
      viewerMembershipStatus:
        membership.membership_status === "banned"
          ? "banned"
          : canAccessCommunity(membership)
            ? "member"
            : "not_member",
      viewerFollowing: followStatus === "active",
    })
  } finally {
    db.close()
  }
}

export async function getPublicCommunityPreview(input: {
  env: Env
  communityId: string
  locale?: string | null
  communityRepository: CommunityRepository
}): Promise<CommunityPreview> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    return await buildCommunityPreview({
      client: db.client,
      communityId: input.communityId,
      communityDisplayName: community.display_name,
      communityCreatedAt: community.created_at,
      locale: input.locale ?? null,
      gateRules: rules,
      viewerMembershipStatus: "not_member",
      viewerFollowing: false,
    })
  } finally {
    db.close()
  }
}

async function listPublicCommunityRules(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
}): Promise<CommunityPreviewRule[]> {
  const result = await input.client.execute({
    sql: `
      SELECT rule_id, title, body, report_reason, position, status
      FROM community_rules
      WHERE community_id = ?1
        AND status = 'active'
      ORDER BY position ASC, created_at ASC
    `,
    args: [input.communityId],
  })

  return result.rows.map((row, index) => ({
    rule_id: String(row.rule_id),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    report_reason:
      row.report_reason == null || String(row.report_reason).trim().length === 0
        ? String(row.title ?? "")
        : String(row.report_reason),
    position: typeof row.position === "number" ? row.position : index,
    status: row.status === "archived" ? "archived" : "active",
  }))
}

async function buildCommunityPreview(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  communityDisplayName: string
  communityCreatedAt: string
  locale?: string | null
  gateRules: Awaited<ReturnType<typeof listActiveMembershipGateRules>>
  viewerMembershipStatus: CommunityPreview["viewer_membership_status"]
  viewerFollowing: boolean
}): Promise<CommunityPreview> {
  const localResult = await input.client.execute({
    sql: `
      SELECT display_name, description, avatar_ref, banner_ref, membership_mode,
             donation_policy_mode, donation_partner_id, settings_json
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  const localRow = localResult.rows[0]
  const settings = parsePreviewSettingsJson(localRow?.settings_json)
  const referenceLinks = parseStoredReferenceLinks(settings)
    .filter((link) => link.link_status === "active")

  let donationPartner: CommunityPreview["donation_partner"] = null
  if (localRow?.donation_partner_id) {
    const partnerResult = await input.client.execute({
      sql: `
        SELECT donation_partner_id, display_name, provider, provider_partner_ref,
               image_url, review_status, status
        FROM donation_partners
        WHERE donation_partner_id = ?1
        LIMIT 1
      `,
      args: [String(localRow.donation_partner_id)],
    })
    const partnerRow = partnerResult.rows[0]
    if (partnerRow) {
      donationPartner = {
        donation_partner_id: String(partnerRow.donation_partner_id),
        display_name: String(partnerRow.display_name),
        provider: partnerRow.provider === "endaoment" ? "endaoment" : "endaoment",
        provider_partner_ref: partnerRow.provider_partner_ref == null ? null : String(partnerRow.provider_partner_ref),
        image_url: partnerRow.image_url == null ? null : String(partnerRow.image_url),
        review_status:
          partnerRow.review_status === "pending" || partnerRow.review_status === "rejected"
            ? partnerRow.review_status
            : "approved",
        status:
          partnerRow.status === "paused" || partnerRow.status === "retired"
            ? partnerRow.status
            : "active",
      }
    }
  }

  const donationPolicyMode: CommunityPreview["donation_policy_mode"] =
    localRow?.donation_policy_mode === "optional_creator_sidecar" || localRow?.donation_policy_mode === "fundraiser_default"
      ? "optional_creator_sidecar"
      : "none"
  const membershipMode: CommunityPreview["membership_mode"] =
    localRow?.membership_mode === "open" || localRow?.membership_mode === "request" || localRow?.membership_mode === "gated"
      ? (localRow.membership_mode as CommunityPreview["membership_mode"])
      : "open"
  const displayName = localRow?.display_name ? String(localRow.display_name) : input.communityDisplayName
  const publicRules = await listPublicCommunityRules({
    client: input.client,
    communityId: input.communityId,
  })
  const followerCount = await getCommunityFollowerCount(input.client, input.communityId)
  const memberCount = await getCommunityMemberCount(input.client, input.communityId)

  const preview: CommunityPreview = {
    community_id: input.communityId,
    display_name: displayName,
    description: localRow?.description != null ? String(localRow.description) : null,
    rules: publicRules,
    avatar_ref: resolveCommunityAvatarRef({
      communityId: input.communityId,
      displayName,
      avatarRef: localRow?.avatar_ref == null ? null : String(localRow.avatar_ref),
    }),
    banner_ref: resolveCommunityBannerRef({
      communityId: input.communityId,
      displayName,
      bannerRef: localRow?.banner_ref == null ? null : String(localRow.banner_ref),
    }),
    membership_mode: membershipMode,
    human_verification_lane: "self",
    member_count: memberCount,
    follower_count: followerCount,
    donation_policy_mode: donationPolicyMode,
    donation_partner_id: localRow?.donation_partner_id == null ? null : String(localRow.donation_partner_id),
    donation_partner: donationPolicyMode !== "none" ? donationPartner : null,
    reference_links: referenceLinks,
    membership_gate_summaries: input.gateRules.map(buildMembershipGateSummary),
    viewer_membership_status: input.viewerMembershipStatus,
    viewer_following: input.viewerFollowing,
    created_at: input.communityCreatedAt,
  }

  if (input.locale == null) {
    return preview
  }

  const localized = await buildLocalizedCommunityPreview({
    executor: input.client,
    preview,
    locale: input.locale,
  })
  await enqueueCommunityTextTranslationOnReadIfNeeded({
    executor: input.client,
    communityId: input.communityId,
    localization: localized.localized_text,
  })
  return localized
}
