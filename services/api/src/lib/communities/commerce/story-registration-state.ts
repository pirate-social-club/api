import type {
  StoryLicensePreset,
  StoryRoyaltyRegistrationResult,
} from "../../story/story-royalty-registration-service"
import type { Asset, Post } from "../../../types"
import type { AssetRow } from "./row-types"

export function shouldAttemptStoryRoyaltyRegistration(input: {
  assetKind: Asset["asset_kind"]
  rightsBasis: Post["rights_basis"] | null
  hasSongBundle: boolean
}): boolean {
  const isStoryAsset = input.assetKind === "song_audio" || input.assetKind === "video_file"
  const hasRoyaltyRightsBasis = input.rightsBasis === "original" || input.rightsBasis === "derivative"
  if (!isStoryAsset || !hasRoyaltyRightsBasis) return false
  return input.assetKind !== "song_audio" || input.hasSongBundle
}

type StoryRoyaltyRegistrationIdentity = Pick<
  AssetRow,
  "story_royalty_registration_status" | "story_ip_id" | "story_license_terms_id"
>

export function hasCompleteStoryRoyaltyRegistration(asset: StoryRoyaltyRegistrationIdentity): boolean {
  return asset.story_royalty_registration_status === "registered"
    && Boolean(asset.story_ip_id?.trim())
    && Boolean(asset.story_license_terms_id?.trim())
}

export function hasStartedStoryRoyaltyRegistration(asset: StoryRoyaltyRegistrationIdentity): boolean {
  return asset.story_royalty_registration_status !== "none"
    && asset.story_royalty_registration_status !== "failed"
}

type StoryRegisteredProjectionCandidate = {
  assetKind: Asset["asset_kind"]
  publicationStatus: Asset["publication_status"]
  storyStatus: Asset["story_status"]
  storyRoyaltyRegistrationStatus: "none" | "pending" | "registered" | "failed"
  storyIpId: string | null
  storyLicenseTermsId: string | null
  ipRoyaltyVault: string | null
  royaltyAllocationStatus: AssetRow["royalty_allocation_status"]
}

function isRegisteredStoryAsset(input: StoryRegisteredProjectionCandidate): input is StoryRegisteredProjectionCandidate & {
  assetKind: "song_audio" | "video_file"
  storyIpId: string
} {
  return (input.assetKind === "song_audio" || input.assetKind === "video_file")
    && input.publicationStatus === "story_published"
    && input.storyStatus === "published"
    && input.storyRoyaltyRegistrationStatus === "registered"
    && Boolean(input.storyIpId?.trim())
}

export function isCatalogProjectableStoryRegisteredAsset(
  input: StoryRegisteredProjectionCandidate,
): input is StoryRegisteredProjectionCandidate & {
  assetKind: "song_audio" | "video_file"
  storyIpId: string
  storyLicenseTermsId: string
} {
  return isRegisteredStoryAsset(input)
    && Boolean(input.storyLicenseTermsId?.trim())
}

export function isRoyaltyProjectableStoryRegisteredAsset(
  input: StoryRegisteredProjectionCandidate,
): input is StoryRegisteredProjectionCandidate & {
  assetKind: "song_audio" | "video_file"
  storyIpId: string
  ipRoyaltyVault: string
} {
  return isRegisteredStoryAsset(input)
    && Boolean(input.ipRoyaltyVault?.trim())
    && input.royaltyAllocationStatus !== "none"
}

export type StoryRegistrationFieldState = {
  storyIpId: string | null
  storyIpNftContract: string | null
  storyIpNftTokenId: string | null
  storyIpMetadataUri: string | null
  storyIpMetadataHash: string | null
  storyNftMetadataUri: string | null
  storyNftMetadataHash: string | null
  ipRoyaltyVault: string | null
  storyPublishModel: "pirate_v1" | "story_ip_v1"
  storyLicenseTermsId: string | null
  storyLicenseTemplate: string | null
  storyRoyaltyPolicy: string | null
  storyRoyaltyPolicyId: string | null
  storyDerivativeParentIpIdsJson: string | null
  storyDerivativeRegisteredAt: string | null
  storyRevenueToken: string | null
  storyRoyaltyRegistrationStatus: AssetRow["story_royalty_registration_status"]
  storyPublishTxRef: string | null
  storyAssetVersionId: string | null
  storyCdrVaultUuid: number | null
  storyNamespace: string | null
  storyEntitlementTokenId: string | null
  storyReadCondition: string | null
  storyWriteCondition: string | null
  effectiveLicensePreset: StoryLicensePreset | null
  effectiveCommercialRevSharePct: number | null
}

export function storyRegistrationFieldStateFromAsset(
  asset: AssetRow,
  overrides: Partial<StoryRegistrationFieldState> = {},
): StoryRegistrationFieldState {
  return {
    storyIpId: asset.story_ip_id,
    storyIpNftContract: asset.story_ip_nft_contract,
    storyIpNftTokenId: asset.story_ip_nft_token_id,
    storyIpMetadataUri: asset.story_ip_metadata_uri,
    storyIpMetadataHash: asset.story_ip_metadata_hash,
    storyNftMetadataUri: asset.story_nft_metadata_uri,
    storyNftMetadataHash: asset.story_nft_metadata_hash,
    ipRoyaltyVault: asset.ip_royalty_vault,
    storyPublishModel: asset.story_publish_model,
    storyLicenseTermsId: asset.story_license_terms_id,
    storyLicenseTemplate: asset.story_license_template,
    storyRoyaltyPolicy: asset.story_royalty_policy,
    storyRoyaltyPolicyId: asset.story_royalty_policy_id,
    storyDerivativeParentIpIdsJson: asset.story_derivative_parent_ip_ids_json,
    storyDerivativeRegisteredAt: asset.story_derivative_registered_at,
    storyRevenueToken: asset.story_revenue_token,
    storyRoyaltyRegistrationStatus: asset.story_royalty_registration_status,
    storyPublishTxRef: asset.story_publish_tx_ref,
    storyAssetVersionId: asset.story_asset_version_id,
    storyCdrVaultUuid: asset.story_cdr_vault_uuid,
    storyNamespace: asset.story_namespace,
    storyEntitlementTokenId: asset.story_entitlement_token_id,
    storyReadCondition: asset.story_read_condition,
    storyWriteCondition: asset.story_write_condition,
    effectiveLicensePreset: asset.license_preset as StoryLicensePreset | null,
    effectiveCommercialRevSharePct: asset.commercial_rev_share_pct,
    ...overrides,
  }
}

export function emptyStoryRegistrationFieldState(
  overrides: Partial<StoryRegistrationFieldState> = {},
): StoryRegistrationFieldState {
  return {
    storyIpId: null,
    storyIpNftContract: null,
    storyIpNftTokenId: null,
    storyIpMetadataUri: null,
    storyIpMetadataHash: null,
    storyNftMetadataUri: null,
    storyNftMetadataHash: null,
    ipRoyaltyVault: null,
    storyPublishModel: "pirate_v1",
    storyLicenseTermsId: null,
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: null,
    storyRoyaltyPolicyId: null,
    storyDerivativeParentIpIdsJson: null,
    storyDerivativeRegisteredAt: null,
    storyRevenueToken: null,
    storyRoyaltyRegistrationStatus: "none",
    storyPublishTxRef: null,
    storyAssetVersionId: null,
    storyCdrVaultUuid: null,
    storyNamespace: null,
    storyEntitlementTokenId: null,
    storyReadCondition: null,
    storyWriteCondition: null,
    effectiveLicensePreset: null,
    effectiveCommercialRevSharePct: null,
    ...overrides,
  }
}

export function applyReusableOriginalRegistrationFields(
  state: StoryRegistrationFieldState,
  registration: AssetRow,
): void {
  state.storyIpId = registration.story_ip_id
  state.storyIpNftContract = registration.story_ip_nft_contract
  state.storyIpNftTokenId = registration.story_ip_nft_token_id
  state.storyIpMetadataUri = registration.story_ip_metadata_uri
  state.storyIpMetadataHash = registration.story_ip_metadata_hash
  state.storyNftMetadataUri = registration.story_nft_metadata_uri
  state.storyNftMetadataHash = registration.story_nft_metadata_hash
  state.ipRoyaltyVault = registration.ip_royalty_vault
  state.storyPublishModel = registration.story_publish_model
  state.storyLicenseTermsId = registration.story_license_terms_id
  state.storyLicenseTemplate = registration.story_license_template
  state.storyRoyaltyPolicy = registration.story_royalty_policy
  state.storyRoyaltyPolicyId = registration.story_royalty_policy_id
  state.storyDerivativeParentIpIdsJson = registration.story_derivative_parent_ip_ids_json
  state.storyDerivativeRegisteredAt = registration.story_derivative_registered_at
  state.storyRevenueToken = registration.story_revenue_token
  state.storyRoyaltyRegistrationStatus = "registered"
  state.storyPublishTxRef = registration.story_publish_tx_ref
  state.storyAssetVersionId = registration.story_asset_version_id
  state.storyCdrVaultUuid = registration.story_cdr_vault_uuid
  state.storyNamespace = registration.story_namespace
  state.storyEntitlementTokenId = registration.story_entitlement_token_id
  state.storyReadCondition = registration.story_read_condition
  state.storyWriteCondition = registration.story_write_condition
  state.effectiveLicensePreset = registration.license_preset as StoryLicensePreset | null
  state.effectiveCommercialRevSharePct = registration.commercial_rev_share_pct
}

export function applyRoyaltyRegistrationFields(
  state: StoryRegistrationFieldState,
  registration: StoryRoyaltyRegistrationResult,
): void {
  state.storyIpId = registration.storyIpId
  state.storyIpNftContract = registration.storyIpNftContract
  state.storyIpNftTokenId = registration.storyIpNftTokenId
  state.storyIpMetadataUri = registration.storyIpMetadataUri
  state.storyIpMetadataHash = registration.storyIpMetadataHash
  state.storyNftMetadataUri = registration.storyNftMetadataUri
  state.storyNftMetadataHash = registration.storyNftMetadataHash
  state.ipRoyaltyVault = registration.ipRoyaltyVault ?? null
  state.storyPublishModel = "story_ip_v1"
  state.storyLicenseTermsId = registration.storyLicenseTermsId
  state.storyLicenseTemplate = registration.storyLicenseTemplate
  state.storyRoyaltyPolicy = registration.storyRoyaltyPolicy
  state.storyRoyaltyPolicyId = registration.storyRoyaltyPolicy
  state.storyDerivativeParentIpIdsJson = registration.storyDerivativeParentIpIds
    ? JSON.stringify(registration.storyDerivativeParentIpIds)
    : null
  state.storyDerivativeRegisteredAt = registration.storyDerivativeRegisteredAt
  state.storyRevenueToken = registration.storyRevenueToken
  state.storyRoyaltyRegistrationStatus = registration.storyRoyaltyRegistrationStatus
}
