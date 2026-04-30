import type { UserRepository } from "../../auth/repositories"
import { badRequestError, eligibilityFailed, internalError } from "../../errors"
import { nowIso } from "../../helpers"
import type {
  Community,
  CreateCommunityRequest,
  User,
} from "../../../types"
import { getPrimaryWalletSnapshot } from "../community-serialization"
import { assertPublicV0GateConfiguration } from "../community-gate-validation"
import type { GatePolicy } from "../membership/gate-types"

export type CreateCommunityRequestBody = Omit<CreateCommunityRequest, "gate_policy"> & {
  gate_policy?: unknown
}

export function assertCreateRequest(
  body: CreateCommunityRequestBody,
  input: {
    ageOver18Verified: boolean
  },
): asserts body is CreateCommunityRequestBody & {
  display_name: string
  gate_policy?: GatePolicy | null
} {
  if (!body.display_name?.trim()) {
    throw badRequestError("display_name is required")
  }
  if (body.avatar_ref != null && typeof body.avatar_ref !== "string") {
    throw badRequestError("avatar_ref must be a string or null")
  }
  if (body.banner_ref != null && typeof body.banner_ref !== "string") {
    throw badRequestError("banner_ref must be a string or null")
  }
  if (body.namespace != null && !body.namespace.namespace_verification?.trim()) {
    throw badRequestError("namespace.namespace_verification is required when namespace is provided")
  }
  if ((body.governance_mode ?? "centralized") !== "centralized") {
    throw eligibilityFailed("Only centralized community creation is allowed in public v0")
  }
  if ((body.handle_policy?.policy_template ?? "standard") !== "standard") {
    throw eligibilityFailed("Public v0 community creation requires the standard handle policy")
  }
  if (body.donation_policy != null) {
    throw eligibilityFailed("Public v0 community creation does not accept donation payloads")
  }
  if (body.community_bootstrap?.label_policy != null || body.community_bootstrap?.resource_links != null) {
    throw eligibilityFailed("Public v0 community creation does not support labels or resource links yet")
  }
  assertPublicV0GateConfiguration(body, input)
}

export type CreateCommunityAuth = {
  userId: string
  user: User
  communityDisplayName: string
  actorPrimaryWalletSnapshot: string | null
  namespaceVerificationId: string | null
  createdAt: string
}

export async function resolveCreateCommunityAuth(input: {
  userId: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
}): Promise<CreateCommunityAuth> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community create")
  }

  assertCreateRequest(input.body, {
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const actorPrimaryWalletSnapshot = getPrimaryWalletSnapshot(user, walletAttachments)

  return {
    userId: input.userId,
    user,
    communityDisplayName: input.body.display_name.trim(),
    actorPrimaryWalletSnapshot,
    namespaceVerificationId: input.body.namespace?.namespace_verification?.trim().replace(/^nv_/, "") || null,
    createdAt: nowIso(),
  }
}

export function parseCommunitySettingsJson(
  rawSettingsJson: unknown,
): Record<string, unknown> {
  if (typeof rawSettingsJson !== "string" || rawSettingsJson.trim().length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawSettingsJson) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    console.warn("[community-create] failed to parse stored settings JSON", error)
  }

  return {}
}

export function parseStoredDonationPartnerSummary(
  settings: Record<string, unknown>,
): (NonNullable<Community["donation_partner"]> & { image_url?: string | null }) | null {
  const rawPartner = settings.donation_partner
  if (!rawPartner || typeof rawPartner !== "object" || Array.isArray(rawPartner)) {
    return null
  }

  const partner = rawPartner as Record<string, unknown>
  if (
    typeof partner.donation_partner_id !== "string"
    || typeof partner.display_name !== "string"
    || partner.provider !== "endaoment"
  ) {
    return null
  }

  return {
    donation_partner: partner.donation_partner_id,
    display_name: partner.display_name,
    provider: "endaoment",
    provider_partner_ref: typeof partner.provider_partner_ref === "string" ? partner.provider_partner_ref : null,
    image_url: typeof partner.image_url === "string" ? partner.image_url : null,
    review_status: partner.review_status === "pending" || partner.review_status === "rejected"
      ? partner.review_status
      : "approved",
    status: partner.status === "paused" || partner.status === "retired"
      ? partner.status
      : "active",
  }
}

export function parseEndaomentLookupTerm(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d{9}$/u.test(trimmed)) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    if (!host.endsWith("endaoment.org")) {
      return null
    }

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.length >= 2 && segments[0] === "orgs" && segments[1].trim()) {
      return decodeURIComponent(segments[1].trim())
    }
  } catch {
    return null
  }

  return null
}

export type EndaomentOrganizationSearchResult = {
  id: string
  ein?: string | null
  name: string
  logo?: string | null
  isCompliant?: boolean
}

export function selectEndaomentOrganizationMatch(
  organizations: EndaomentOrganizationSearchResult[],
  lookupTerm: string,
): EndaomentOrganizationSearchResult | null {
  const normalizedLookupTerm = lookupTerm.trim().toLowerCase()
  const exactEin = organizations.find((org) => (org.ein ?? "").trim().toLowerCase() === normalizedLookupTerm)
  if (exactEin) {
    return exactEin
  }

  return organizations.find((org) => org.id.trim().toLowerCase() === normalizedLookupTerm) ?? organizations[0] ?? null
}
