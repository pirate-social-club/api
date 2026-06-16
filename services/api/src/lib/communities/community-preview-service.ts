import {
  buildMembershipGateSummariesFromPolicy,
  getGatePolicyMatchMode,
} from "./membership/gates"
import {
  canAccessCommunity,
  getCommunityMemberCount,
  getCommunityMembershipState,
} from "./membership/membership-state-store"
import { getMembershipGatePolicy } from "./membership/gate-policy-store"
import {
  getCommunityFollowStatus,
  getCommunityFollowerCount,
} from "./membership/follow-store"
import { openCommunityReadClient } from "./community-read-access"
import type { ReadClient } from "../sql-client"

type CommunityReadClient = ReadClient
import {
  buildLocalizedCommunityPreview,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "../localization/community-localization-service"
import {
  resolveCommunityAvatarRef,
  resolveCommunityBannerRef,
} from "./community-identity-media"
import { serializeDonationPartnerRow } from "./community-donation-partner-serialization"
import { parseStoredCountryCode, parseStoredReferenceLinks } from "./community-serialization"
import { isCommunityLive } from "./community-status"
import { getControlPlaneClient } from "../runtime-deps"
import { dedupeStrings, splitCsv } from "../helpers"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { notFoundError } from "../errors"
import type {
  CommunityPreview,
  CommunityRoleSummary,
  Env,
} from "../../types"
import type { GatePolicy } from "./membership/gate-types"

type CommunityPreviewRule = NonNullable<CommunityPreview["rules"]>[number]
type AgentOwnershipProvider = NonNullable<CommunityPreview["accepted_agent_ownership_providers"]>[number]

type CommunityPreviewRepository = CommunityReadRepository & CommunityDatabaseBindingRepository
const DEFAULT_PLATFORM_APPROVED_DERIVED_KYA_PROVIDERS = ["clawkey"] as const

function parsePreviewSettingsJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    console.warn("[community-preview] failed to parse preview settings JSON", error)
  }

  return {}
}

function parsePreviewAllowedDisclosedQualifiers(
  settings: Record<string, unknown>,
): CommunityPreview["allowed_disclosed_qualifiers"] {
  const rawQualifiers = settings.allowed_disclosed_qualifiers
  if (!Array.isArray(rawQualifiers)) {
    return null
  }

  const qualifierIds = rawQualifiers
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)

  return qualifierIds.length ? [...new Set(qualifierIds)] : null
}

function parsePreviewAllowQualifiersOnAnonymousPosts(
  settings: Record<string, unknown>,
): CommunityPreview["allow_qualifiers_on_anonymous_posts"] {
  return typeof settings.allow_qualifiers_on_anonymous_posts === "boolean"
    ? settings.allow_qualifiers_on_anonymous_posts
    : null
}

function parsePreviewGuestCommentPolicy(
  settings: Record<string, unknown>,
): CommunityPreview["guest_comment_policy"] {
  return settings.guest_comment_policy === "altcha_required" ? "altcha_required" : "disallow"
}

function parsePreviewAgentPostingPolicy(
  settings: Record<string, unknown>,
): CommunityPreview["agent_posting_policy"] {
  const rawValue = settings.agent_posting_policy
  if (rawValue === "review" || rawValue === "allow_with_disclosure" || rawValue === "allow") {
    return rawValue
  }
  return "disallow"
}

function parsePreviewAgentPostingScope(
  settings: Record<string, unknown>,
): CommunityPreview["agent_posting_scope"] {
  return settings.agent_posting_scope === "top_level_and_replies"
    ? "top_level_and_replies"
    : "replies_only"
}

function parsePreviewPositiveInteger(
  settings: Record<string, unknown>,
  key: string,
): number | null {
  const value = settings[key]
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : null
}

function parsePreviewAcceptedAgentOwnershipProviders(
  settings: Record<string, unknown>,
): AgentOwnershipProvider[] | null {
  const rawProviders = settings.accepted_agent_ownership_providers
  if (!Array.isArray(rawProviders)) {
    return null
  }

  return [...new Set(rawProviders.filter((value): value is AgentOwnershipProvider =>
    value === "self_agent_id" || value === "clawkey"
  ))]
}

function resolvePreviewAcceptedAgentOwnershipProviders(input: {
  env: Env
  settings: Record<string, unknown>
  humanVerificationLane: CommunityPreview["human_verification_lane"]
}): AgentOwnershipProvider[] {
  const explicit = parsePreviewAcceptedAgentOwnershipProviders(input.settings)
  if (explicit !== null) {
    return explicit
  }

  if (input.humanVerificationLane === "very") {
    return input.env.PLATFORM_APPROVED_KYA_PROVIDERS == null
      ? [...DEFAULT_PLATFORM_APPROVED_DERIVED_KYA_PROVIDERS]
      : dedupeStrings(splitCsv(input.env.PLATFORM_APPROVED_KYA_PROVIDERS))
          .filter((value): value is AgentOwnershipProvider => value === "self_agent_id" || value === "clawkey")
  }

  return []
}

function parsePreviewHumanVerificationLane(
  settings: Record<string, unknown>,
  summaries: NonNullable<CommunityPreview["membership_gate_summaries"]>,
): CommunityPreview["human_verification_lane"] {
  if (settings.human_verification_lane === "self" || settings.human_verification_lane === "very") {
    return settings.human_verification_lane
  }

  if (summaries.some((summary) =>
    summary.gate_type === "nationality"
    || summary.gate_type === "gender"
    || summary.gate_type === "minimum_age"
    || (summary.gate_type !== "unique_human" && summary.accepted_providers?.includes("self"))
  )) {
    return "self"
  }

  if (summaries.some((summary) =>
    summary.gate_type === "unique_human"
    && (!summary.accepted_providers?.length || summary.accepted_providers.includes("very"))
  )) {
    return "very"
  }

  if (summaries.some((summary) =>
    summary.gate_type === "unique_human"
    && summary.accepted_providers?.includes("self")
  )) {
    return "self"
  }

  return "very"
}

async function getActiveCommunityForPreview(
  repository: Pick<CommunityReadRepository, "getCommunityById">,
  communityId: string,
): Promise<{
  creator_user_id: string
  display_name: string
  created_at: string
  namespace_verification_id?: string | null
  route_slug?: string | null
}> {
  const community = await repository.getCommunityById(communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }
  return community
}

async function getCommunityRoleSummary(input: {
  env: Env
  userId: string
  role: "owner" | "admin" | "moderator"
}): Promise<CommunityRoleSummary | null> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT p.user_id, p.display_name, p.avatar_ref, gh.label_display
      FROM profiles p
      JOIN global_handles gh ON gh.global_handle_id = p.global_handle_id
      WHERE p.user_id = ?1
      LIMIT 1
    `,
    args: [input.userId],
  })
  const row = result.rows[0]
  if (!row) {
    return null
  }

  const handle = String(row.label_display ?? "").trim()
  const displayName = String(row.display_name ?? "").trim() || handle
  if (!handle || !displayName) {
    return null
  }

  return {
    user: `usr_${String(row.user_id)}`,
    display_name: displayName,
    handle,
    avatar_ref: row.avatar_ref == null ? null : String(row.avatar_ref),
    nationality_badge_country: null,
    role: input.role,
  }
}

async function getCommunityOwnerUserId(
  client: CommunityReadClient,
  communityId: string,
): Promise<string | null> {
  const result = await client.execute({
    sql: `
      SELECT user_id
      FROM community_roles
      WHERE community_id = ?1
        AND status = 'active'
        AND role = 'owner'
      ORDER BY granted_at ASC, created_at ASC, role_assignment_id ASC
      LIMIT 1
    `,
    args: [communityId],
  })
  const row = result.rows[0]
  if (!row) {
    return null
  }
  return String(row.user_id)
}

async function listCommunityModeratorRoleAssignments(
  client: CommunityReadClient,
  communityId: string,
): Promise<Array<{ userId: string; role: "admin" | "moderator" }>> {
  const result = await client.execute({
    sql: `
      SELECT user_id, role
      FROM community_roles
      WHERE community_id = ?1
        AND status = 'active'
        AND role IN ('admin', 'moderator')
      ORDER BY
        CASE role WHEN 'admin' THEN 0 ELSE 1 END,
        granted_at ASC,
        created_at ASC,
        role_assignment_id ASC
    `,
    args: [communityId],
  })

  return result.rows
    .map((row) => ({
      userId: String(row.user_id ?? ""),
      role: row.role === "admin" ? "admin" as const : "moderator" as const,
    }))
    .filter((assignment) => assignment.userId.length > 0)
}

async function buildPreviewForViewer(input: {
  env: Env
  communityId: string
  locale?: string | null
  communityRepository: CommunityPreviewRepository
  viewer?: { userId: string } | null
}): Promise<CommunityPreview> {
  const community = await getActiveCommunityForPreview(input.communityRepository, input.communityId)

  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const gatePolicy = await getMembershipGatePolicy(db.client, input.communityId)
    const membership = input.viewer
      ? await getCommunityMembershipState(db.client, input.communityId, input.viewer.userId)
      : null
    const followStatus = input.viewer
      ? await getCommunityFollowStatus(db.client, input.communityId, input.viewer.userId)
      : null
    return await buildCommunityPreview({
      env: input.env,
      client: db.client,
      communityId: input.communityId,
      communityDisplayName: community.display_name,
      communityCreatedAt: community.created_at,
      namespaceVerificationId: community.namespace_verification_id ?? null,
      routeSlug: community.route_slug ?? null,
      locale: input.locale ?? null,
      gatePolicy,
      viewerMembershipStatus:
        membership?.membership_status === "banned"
          ? "banned"
          : membership && canAccessCommunity(membership)
            ? "member"
            : "not_member",
      viewerCommunityRole: membership?.role_status === "active" ? membership.role : null,
      viewerFollowing: followStatus === "active",
    })
  } finally {
    db.close()
  }
}

export async function getCommunityPreview(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  communityRepository: CommunityPreviewRepository
}): Promise<CommunityPreview> {
  return await buildPreviewForViewer({
    ...input,
    viewer: { userId: input.userId },
  })
}

export async function getPublicCommunityPreview(input: {
  env: Env
  communityId: string
  locale?: string | null
  communityRepository: CommunityPreviewRepository
}): Promise<CommunityPreview> {
  return await buildPreviewForViewer(input)
}

export async function getPublicCommunityPreviewFromCommunityDb(input: {
  env: Env
  client: CommunityReadClient
  communityId: string
  locale?: string | null
  communityRepository: CommunityPreviewRepository
}): Promise<CommunityPreview> {
  const community = await getActiveCommunityForPreview(input.communityRepository, input.communityId)
  const gatePolicy = await getMembershipGatePolicy(input.client, input.communityId)
  return await buildCommunityPreview({
    env: input.env,
    client: input.client,
    communityId: input.communityId,
    communityDisplayName: community.display_name,
    communityCreatedAt: community.created_at,
    namespaceVerificationId: community.namespace_verification_id ?? null,
    routeSlug: community.route_slug ?? null,
    locale: input.locale ?? null,
    gatePolicy,
    viewerMembershipStatus: "not_member",
    viewerCommunityRole: null,
    viewerFollowing: false,
  })
}

async function listPublicCommunityRules(input: {
  client: CommunityReadClient
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
    id: `rule_${String(row.rule_id)}`,
    object: "community_rule",
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
  env: Env
  client: CommunityReadClient
  communityId: string
  communityDisplayName: string
  communityCreatedAt: string
  namespaceVerificationId?: string | null
  routeSlug?: string | null
  locale?: string | null
  gatePolicy: GatePolicy | null
  viewerMembershipStatus: CommunityPreview["viewer_membership_status"]
  viewerCommunityRole: CommunityPreview["viewer_community_role"]
  viewerFollowing: boolean
}): Promise<CommunityPreview> {
  const localResult = await input.client.execute({
    sql: `
      SELECT display_name, description, avatar_ref, banner_ref, membership_mode,
             allow_anonymous_identity, anonymous_identity_scope,
             donation_policy_mode, donation_partner_id, settings_json
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  const localRow = localResult.rows[0]
  const settings = parsePreviewSettingsJson(localRow?.settings_json)
  const countryCode = parseStoredCountryCode(settings)
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
      donationPartner = serializeDonationPartnerRow(partnerRow)
    }
  }

  const donationPolicyMode: CommunityPreview["donation_policy_mode"] =
    localRow?.donation_policy_mode === "optional_creator_sidecar" || localRow?.donation_policy_mode === "fundraiser_default"
      ? "optional_creator_sidecar"
      : "none"
  const membershipMode: CommunityPreview["membership_mode"] =
    localRow?.membership_mode === "request" || localRow?.membership_mode === "gated"
      ? (localRow.membership_mode as CommunityPreview["membership_mode"])
      : "gated"
  const displayName = localRow?.display_name ? String(localRow.display_name) : input.communityDisplayName
  const anonymousIdentityScope: CommunityPreview["anonymous_identity_scope"] =
    localRow?.anonymous_identity_scope === "community_stable"
      || localRow?.anonymous_identity_scope === "thread_stable"
      || localRow?.anonymous_identity_scope === "post_ephemeral"
      ? localRow.anonymous_identity_scope
      : null
  const membershipGateSummaries = membershipMode === "gated"
    ? buildMembershipGateSummariesFromPolicy(input.gatePolicy)
    : []
  const publicRules = await listPublicCommunityRules({
    client: input.client,
    communityId: input.communityId,
  })
  const ownerUserId = await getCommunityOwnerUserId(input.client, input.communityId)
  const moderatorAssignments = await listCommunityModeratorRoleAssignments(input.client, input.communityId)
  const [followerCount, memberCount, owner, moderators] = await Promise.all([
    getCommunityFollowerCount(input.client, input.communityId),
    getCommunityMemberCount(input.client, input.communityId),
    ownerUserId
      ? getCommunityRoleSummary({ env: input.env, userId: ownerUserId, role: "owner" }).catch((error) => {
          console.error("[community-preview] owner role summary failed", {
            communityId: input.communityId,
            userId: ownerUserId,
            error,
          })
          return null
        })
      : Promise.resolve(null),
    Promise.all(moderatorAssignments.map((assignment) =>
      getCommunityRoleSummary({
        env: input.env,
        userId: assignment.userId,
        role: assignment.role,
      }).catch((error) => {
        console.error("[community-preview] moderator role summary failed", {
          communityId: input.communityId,
          userId: assignment.userId,
          role: assignment.role,
          error,
        })
        return null
      })
    )),
  ])

  const humanVerificationLane = parsePreviewHumanVerificationLane(settings, membershipGateSummaries)
  const preview: CommunityPreview = {
    community_id: input.communityId,
    display_name: displayName,
    description: localRow?.description != null ? String(localRow.description) : null,
    namespace_verification_id: input.namespaceVerificationId ?? null,
    route_slug: input.routeSlug ?? null,
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
    country_code: countryCode,
    membership_mode: membershipMode,
    allow_anonymous_identity: Number(localRow?.allow_anonymous_identity ?? 0) === 1,
    anonymous_identity_scope: anonymousIdentityScope,
    guest_comment_policy: parsePreviewGuestCommentPolicy(settings),
    agent_posting_policy: parsePreviewAgentPostingPolicy(settings),
    agent_posting_scope: parsePreviewAgentPostingScope(settings),
    agent_daily_post_cap: parsePreviewPositiveInteger(settings, "agent_daily_post_cap"),
    agent_daily_reply_cap: parsePreviewPositiveInteger(settings, "agent_daily_reply_cap"),
    accepted_agent_ownership_providers: resolvePreviewAcceptedAgentOwnershipProviders({
      env: input.env,
      settings,
      humanVerificationLane,
    }),
    allowed_disclosed_qualifiers: parsePreviewAllowedDisclosedQualifiers(settings),
    allow_qualifiers_on_anonymous_posts: parsePreviewAllowQualifiersOnAnonymousPosts(settings),
    human_verification_lane: humanVerificationLane,
    member_count: memberCount,
    follower_count: followerCount,
    donation_policy_mode: donationPolicyMode,
    donation_partner_id: localRow?.donation_partner_id == null ? null : String(localRow.donation_partner_id),
    donation_partner: donationPolicyMode !== "none" ? donationPartner : null,
    owner,
    moderators: moderators.filter((summary): summary is CommunityRoleSummary => summary !== null),
    reference_links: referenceLinks,
    membership_gate_summaries: membershipGateSummaries,
    gate_match_mode: membershipMode === "gated" ? getGatePolicyMatchMode(input.gatePolicy) : null,
    viewer_membership_status: input.viewerMembershipStatus,
    viewer_community_role: input.viewerCommunityRole,
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
