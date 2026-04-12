export type {
  AuthProof,
  CommunityMoneyPolicy,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  CommunityCreateAcceptedResponse,
  CompleteNamespaceVerificationSessionRequest,
  CompleteVerificationSessionRequest,
  CreateSongArtifactUploadRequest,
  ErrorResponse,
  GlobalHandle,
  Job,
  NamespaceVerification,
  NamespaceVerificationAssertions,
  NamespaceVerificationCapabilities,
  NamespaceVerificationSession,
  OnboardingStatus,
  Profile,
  RedditImportSummary,
  RedditVerification,
  SessionExchangeRequest,
  SessionExchangeResponse,
  StartNamespaceVerificationSessionRequest,
  SongArtifactUpload,
  UpdateCommunityMoneyPolicyRequest,
  User,
  VerificationCapabilities,
  WalletAttachmentSummary,
} from "@pirate/api-contracts"

export type {
  CommunityListing,
  CommunityListingListResponse,
  CreateCommunityListingRequest,
  UpdateCommunityListingRequest,
  CommunityPurchase,
  CommunityPurchaseListResponse,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
} from "../../contracts/src/index"

type ContractCreateCommunityRequest = import("@pirate/api-contracts").CreateCommunityRequest
type ContractCommunity = import("@pirate/api-contracts").Community
type ContractPost = import("@pirate/api-contracts").Post
type ContractGateRule = NonNullable<ContractCommunity["gate_rules"]>[number]
type ContractVerificationIntent = NonNullable<import("@pirate/api-contracts").StartVerificationSessionRequest["verification_intent"]>

export type VerificationIntent = ContractVerificationIntent | "ucommunity_join"

export type StartVerificationSessionRequest = Omit<
  import("@pirate/api-contracts").StartVerificationSessionRequest,
  "verification_intent"
> & {
  verification_intent?: VerificationIntent | null
}

export type VerificationSession = Omit<
  import("@pirate/api-contracts").VerificationSession,
  "verification_intent"
> & {
  verification_intent?: VerificationIntent | null
}

export type CreateCommunityRequest = ContractCreateCommunityRequest & {
  description?: string | null
  membership_mode?: "open" | "request" | "gated"
  allow_anonymous_identity?: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  default_age_gate_policy?: "none" | "18_plus"
  donation_policy?: unknown
  community_bootstrap?: unknown
  gate_rules?: Array<{
    scope?: "membership" | "viewer" | "posting"
    gate_family?: "token_holding" | "identity_proof"
    gate_type?: string
    proof_requirements?: Array<{
      proof_type?: string
      accepted_providers?: string[] | null
      accepted_mechanisms?: string[] | null
      config?: Record<string, unknown> | null
    }> | null
    chain_namespace?: string | null
    gate_config?: Record<string, unknown> | null
  }> | null
}

export type UpdateCommunityRequest = {
  description?: string | null
  membership_mode?: "open" | "request" | "gated"
  allow_anonymous_identity?: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  default_age_gate_policy?: "none" | "18_plus"
}

export type DonationPartnerSummary = {
  donation_partner_id: string
  display_name: string
  provider: "endaoment"
  provider_partner_ref?: string | null
  review_status: "pending" | "approved" | "rejected"
  status: "active" | "paused" | "retired"
}

export type CommunityDonationPolicy = {
  community_id: string
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donation_partner_status: "unconfigured" | "active" | "paused"
  donation_partner_id?: string | null
  donation_partner?: DonationPartnerSummary | null
  updated_at: string
}

export type UpdateCommunityDonationPolicyRequest = {
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donation_partner_id?: string | null
  donation_partner_status?: "unconfigured" | "active" | "paused" | null
}

export type CommunityPricingVerificationProvider = "self"
export type CommunityPricingAdjustmentType = "multiplier" | "fixed_price_usd"

export type CommunityPricingTier = {
  tier_key: string
  display_name?: string | null
  adjustment_type: CommunityPricingAdjustmentType
  adjustment_value: number
}

export type CommunityPricingCountryAssignment = {
  country_code: string
  tier_key: string
}

export type CommunityPricingPolicy = {
  community_id: string
  policy_origin: "default" | "explicit"
  pricing_policy_version: string
  regional_pricing_enabled: boolean
  verification_provider_requirement?: CommunityPricingVerificationProvider | null
  default_tier_key?: string | null
  tiers: CommunityPricingTier[]
  country_assignments: CommunityPricingCountryAssignment[]
  source_template_id?: string | null
  source_template_version?: string | null
  updated_at: string
}

export type UpdateCommunityPricingPolicyRequest = {
  regional_pricing_enabled: boolean
  verification_provider_requirement?: CommunityPricingVerificationProvider | null
  default_tier_key?: string | null
  tiers: CommunityPricingTier[]
  country_assignments: CommunityPricingCountryAssignment[]
  source_template_id?: string | null
  source_template_version?: string | null
}

export type CommunityContentAuthenticityPolicy = ContractCommunity["content_authenticity_policy"]

export type UpdateCommunityContentAuthenticityPolicyRequest = {
  authenticity_stance: CommunityContentAuthenticityPolicy["authenticity_stance"]
  text_policy: CommunityContentAuthenticityPolicy["text_policy"]
  image_policy: CommunityContentAuthenticityPolicy["image_policy"]
  video_policy: CommunityContentAuthenticityPolicy["video_policy"]
  song_policy: CommunityContentAuthenticityPolicy["song_policy"]
}

export type CommunitySourcePolicy = ContractCommunity["source_policy"]

export type UpdateCommunitySourcePolicyRequest = {
  identified_person_media_scope: CommunitySourcePolicy["identified_person_media_scope"]
  require_source_url_for_reposts: CommunitySourcePolicy["require_source_url_for_reposts"]
  allow_human_made_fan_art_of_real_people: CommunitySourcePolicy["allow_human_made_fan_art_of_real_people"]
  require_fan_art_disclosure: CommunitySourcePolicy["require_fan_art_disclosure"]
}

export type CommunityMarketContextPolicy = ContractCommunity["market_context_policy"]

export type UpdateCommunityMarketContextPolicyRequest = {
  mode: CommunityMarketContextPolicy["mode"]
  enabled_post_types?: CommunityMarketContextPolicy["enabled_post_types"] | null
  max_markets_per_post?: number | null
  provider_set?: CommunityMarketContextPolicy["provider_set"] | null
  market_context_profile_id?: string | null
}

export type CommunityContentAuthenticityDetectionPolicy = ContractCommunity["content_authenticity_detection_policy"]

export type UpdateCommunityContentAuthenticityDetectionPolicyRequest = {
  selection_mode: CommunityContentAuthenticityDetectionPolicy["selection_mode"]
  authenticity_detection_profile_id?: string | null
}

export type CommunityFlairPolicy = {
  flair_enabled: boolean
  require_flair_on_top_level_posts: boolean
  definitions: Array<{
    flair_id: string
    label: string
    description: string | null
    color_token: string | null
    position: number
    allowed_post_types: Array<"text" | "image" | "video" | "song"> | null
    status: "active" | "archived"
  }>
}

export type UpdateCommunityFlairPolicyRequest = {
  flair_enabled?: boolean
  require_flair_on_top_level_posts?: boolean
  definitions?: Array<{
    flair_id?: string
    label?: string
    description?: string | null
    color_token?: string | null
    position?: number
    allowed_post_types?: Array<"text" | "image" | "video" | "song"> | null
    status?: "active" | "archived"
  }>
}

export type CommunityRule = {
  rule_id: string
  title: string
  body: string
  position: number
  status: "active" | "archived"
}

export type CommunityResourceLink = {
  resource_link_id: string
  label: string
  url: string
  resource_kind: "link" | "playlist" | "document" | "discord" | "website" | "other"
  position: number
  status: "active" | "archived"
}

export type CommunityProfile = {
  rules: CommunityRule[]
  resource_links: CommunityResourceLink[]
}

export type UpdateCommunityProfileRequest = {
  rules?: Array<{
    rule_id?: string
    title?: string
    body?: string
    position?: number
    status?: "active" | "archived"
  }>
  resource_links?: Array<{
    resource_link_id?: string
    label?: string
    url?: string
    resource_kind?: "link" | "playlist" | "document" | "discord" | "website" | "other"
    position?: number
    status?: "active" | "archived"
  }>
}

export type ModerationSignalSeverity = "low" | "medium" | "high"
export type ModerationCaseStatus = "open" | "resolved"
export type ModerationQueueScope = "community" | "platform"
export type ModerationCaseOpenedBy = "platform_analysis" | "user_report" | "mixed"
export type UserReportReasonCode = "spam" | "harassment" | "hate" | "sexual_content" | "graphic_content" | "misleading" | "other"
export type ModerationActionType = "dismiss" | "hide" | "remove" | "restore" | "age_gate"

export type CreateUserReportRequest = {
  reason_code: UserReportReasonCode
  note?: string | null
}

export type UserReport = {
  user_report_id: string
  community_id: string
  post_id: string
  moderation_case_id: string | null
  reporter_user_id: string
  reason_code: UserReportReasonCode
  note: string | null
  created_at: string
}

export type ModerationSignal = {
  moderation_signal_id: string
  community_id: string
  post_id: string
  moderation_case_id: string | null
  analysis_result_ref: string | null
  source: "platform_analysis"
  signal_type: string
  severity: ModerationSignalSeverity
  provider: string
  provider_label: string
  evidence_ref: string | null
  created_at: string
}

export type ModerationAction = {
  moderation_action_id: string
  moderation_case_id: string
  community_id: string
  post_id: string
  actor_user_id: string
  action_type: ModerationActionType
  note: string | null
  previous_post_status: ContractPost["status"] | null
  next_post_status: ContractPost["status"] | null
  previous_age_gate_policy: ContractPost["age_gate_policy"] | null
  next_age_gate_policy: ContractPost["age_gate_policy"] | null
  created_at: string
}

export type ModerationCase = {
  moderation_case_id: string
  community_id: string
  post_id: string
  status: ModerationCaseStatus
  queue_scope: ModerationQueueScope
  priority: ModerationSignalSeverity
  opened_by: ModerationCaseOpenedBy
  created_at: string
  updated_at: string
  resolved_at: string | null
}

export type ModerationCaseListResponse = {
  items: ModerationCase[]
}

export type ModerationCaseDetail = {
  case: ModerationCase
  post: Post
  signals: ModerationSignal[]
  reports: UserReport[]
  actions: ModerationAction[]
}

export type CreateModerationActionRequest = {
  action_type: ModerationActionType
  note?: string | null
}

export type CommunityReferenceLinkPlatform =
  | "musicbrainz"
  | "genius"
  | "spotify"
  | "apple_music"
  | "wikipedia"
  | "instagram"
  | "tiktok"
  | "x"
  | "official_website"
  | "youtube"
  | "bandcamp"
  | "soundcloud"
  | "other"

export type CommunityReferenceLinkStatus = "active" | "archived"
export type CommunityReferenceLinkVerificationApplicability = "eligible" | "not_applicable"
export type CommunityReferenceLinkVerificationState = "unverified" | "pending" | "verified" | "rejected" | "revoked"
export type CommunityReferenceLinkVerificationMethod = "bio_code" | "dns_txt" | "website_meta" | "website_file" | "manual_review"

export type CommunityReferenceLinkMetadata = {
  display_name?: string | null
  image_url?: string | null
  [key: string]: unknown
}

export type CreateCommunityReferenceLinkRequest = {
  platform: CommunityReferenceLinkPlatform
  url: string
  label?: string | null
  position?: number | null
}

export type UpdateCommunityReferenceLinkRequest = {
  platform?: CommunityReferenceLinkPlatform
  url?: string
  label?: string | null
  position?: number | null
}

export type CommunityReferenceLinkAdmin = {
  community_reference_link_id: string
  community_id: string
  platform: CommunityReferenceLinkPlatform
  url: string
  normalized_url: string
  external_id: string | null
  label: string | null
  link_status: CommunityReferenceLinkStatus
  verification_applicability: CommunityReferenceLinkVerificationApplicability
  verification_state: CommunityReferenceLinkVerificationState | null
  verification_method: CommunityReferenceLinkVerificationMethod | null
  verified_at: string | null
  last_verification_checked_at: string | null
  active_proof_id: string | null
  metadata: CommunityReferenceLinkMetadata
  position: number
  created_at: string
  updated_at: string
}

export type CommunityGateRule = ContractGateRule

export type CommunityPurchaseQuoteRequest = import("@pirate/api-contracts").CommunityPurchaseQuoteRequest & {
  destination_settlement_amount_atomic?: string | null
  destination_settlement_decimals?: number | null
}

export type CommunityPurchaseQuote = import("@pirate/api-contracts").CommunityPurchaseQuote & {
  destination_settlement_amount_atomic?: string | null
  destination_settlement_decimals?: number | null
}

export type Community = Omit<ContractCommunity, "gate_rules"> & {
  flair_policy?: CommunityFlairPolicy | null
  gate_rules?: CommunityGateRule[] | null
}

export type CreatePostRequest = Omit<import("@pirate/api-contracts").CreatePostRequest, "media_refs"> & {
  media_refs?: MediaDescriptor[]
  flair_id?: string | null
  access_mode?: "public" | "locked"
  upstream_asset_refs?: string[] | null
}

export type Post = Omit<ContractPost, "media_refs"> & {
  media_refs?: MediaDescriptor[]
  lyrics?: string | null
  flair_id?: string | null
  upstream_asset_refs?: string[] | null
}

export type LocalizedPostResponse = import("@pirate/api-contracts").LocalizedPostResponse & {
  flair?: {
    flair_id: string
    label?: string | null
    color_token?: string | null
  } | null
}

export type MediaDescriptor = {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  duration_ms?: number | null
  clip_start_ms?: number | null
  clip_duration_ms?: number | null
  width?: number | null
  height?: number | null
}

export type SongPreviewWindow = {
  start_ms: number
  duration_ms: number
}

export type SongArtifactEnrichmentStatus = "pending" | "processing" | "completed" | "failed"

export type SongTimedLyricsWord = {
  text: string
  start_ms: number
  end_ms: number
  loss: number | null
}

export type SongTimedLyricsLine = {
  id: string
  index: number
  text: string
  start_ms: number | null
  end_ms: number | null
  words: SongTimedLyricsWord[] | null
}

export type SongTimedLyricsDoc = {
  kind: "lyrics.timed.v1"
  version: 1
  timing: "aligned"
  created_at: string
  text_sha256: string
  source: {
    provider: string
    version: string
    loss: number | null
  }
  lines: SongTimedLyricsLine[]
}

export type SongLyricsTranslationLine = {
  id: string
  index: number
  text: string
}

export type SongLyricsTranslationDoc = {
  kind: "lyrics.translation.bundle.v1"
  version: 1
  created_at: string
  model: string
  detected_source_language: string | null
  target_locales: string[]
  translations: Record<string, SongLyricsTranslationLine[]>
}

export type SongModerationResultDoc = {
  kind: "lyrics.moderation.v1"
  version: 1
  created_at: string
  model: string
  detected_source_language: string | null
  sexual_content: "none" | "mild" | "adult" | "graphic"
  sexual_minors: boolean
  self_harm: boolean
  violence: boolean
  hate_or_harassment: boolean
  review_required: boolean
  blocked: boolean
  summary: string
  cover_art_sexual_content: "none" | "mild" | "adult" | "graphic" | null
  cover_art_sexual_minors: boolean
  cover_art_review_required: boolean
  cover_art_blocked: boolean
  cover_art_summary: string | null
}

export type CreateSongArtifactBundleRequest = {
  primary_audio: MediaDescriptor
  lyrics: string
  cover_art?: MediaDescriptor | null
  preview_audio?: MediaDescriptor | null
  preview_window?: SongPreviewWindow | null
  canvas_video?: MediaDescriptor | null
  instrumental_audio?: MediaDescriptor | null
  vocal_audio?: MediaDescriptor | null
}

export type SongArtifactBundle = {
  song_artifact_bundle_id: string
  community_id: string
  creator_user_id: string
  status: "draft" | "validating" | "ready" | "consuming" | "consumed" | "failed"
  primary_audio: MediaDescriptor
  media_refs: MediaDescriptor[]
  lyrics: string
  lyrics_sha256: string
  cover_art?: MediaDescriptor | null
  preview_audio?: MediaDescriptor | null
  preview_window?: SongPreviewWindow | null
  preview_status: SongArtifactEnrichmentStatus
  preview_error: string | null
  canvas_video?: MediaDescriptor | null
  instrumental_audio?: MediaDescriptor | null
  vocal_audio?: MediaDescriptor | null
  translation_status: SongArtifactEnrichmentStatus
  translation_error: string | null
  translated_lyrics_ref: string | null
  translated_lyrics: SongLyricsTranslationDoc | null
  alignment_status: SongArtifactEnrichmentStatus
  alignment_error: string | null
  timed_lyrics_ref: string | null
  timed_lyrics: SongTimedLyricsDoc | null
  moderation_status: SongArtifactEnrichmentStatus
  moderation_error: string | null
  moderation_result_ref: string | null
  moderation_result: SongModerationResultDoc | null
  created_at: string
  updated_at: string
}

export type Asset = {
  asset_id: string
  community_id: string
  source_post_id: string
  song_artifact_bundle_id: string | null
  creator_user_id: string
  asset_kind: "song_audio"
  rights_basis: "none" | "original" | "derivative" | "attribution_only"
  access_mode: "public" | "locked"
  primary_content_ref: string | null
  primary_content_hash: string | null
  preview_audio: MediaDescriptor | null
  cover_art: MediaDescriptor | null
  canvas_video: MediaDescriptor | null
  publication_status: "draft" | "story_requested" | "story_published" | "story_failed" | "withdrawn"
  story_status: "none" | "requested" | "published" | "failed"
  story_error: string | null
  story_ip_id: string | null
  story_ip_nft_contract: string | null
  story_ip_nft_token_id: string | null
  story_publish_tx_ref: string | null
  story_publish_model: "pirate_v1" | "story_ip_v1"
  story_asset_version_id: string | null
  story_license_terms_id: string | null
  story_license_template: string | null
  story_royalty_policy: string | null
  story_derivative_registered_at: string | null
  story_revenue_token: string | null
  story_cdr_vault_uuid: number | null
  story_cdr_encrypted_cid: string | null
  story_cdr_allocate_tx_ref: string | null
  story_cdr_write_tx_ref: string | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_status: "none" | "requested" | "ready" | "failed"
  locked_delivery_ref: string | null
  locked_delivery_error: string | null
  created_at: string
  updated_at: string
}

export type AssetAccessResponse = {
  asset_id: string
  community_id: string
  source_post_id: string
  access_mode: Asset["access_mode"]
  source_post_status: Post["status"]
  story_status: Asset["story_status"]
  locked_delivery_status: Asset["locked_delivery_status"]
  access_granted: boolean
  decision_reason: "public" | "creator" | "moderator" | "purchase_entitlement" | "purchase_required" | "delivery_pending"
  delivery_kind: "primary_content_ref" | "locked_delivery_ref" | null
  delivery_ref: string | null
}

export type AssetAccessProofResponse = {
  asset_id: string
  community_id: string
  access_mode: "locked"
  decision_reason: "creator" | "moderator" | "purchase_entitlement"
  delivery_ref: string
  wallet_attachment_id: string
  caller_address: string
  signer_family: "story-access-controller"
  signer_address: string
  verifier_contract: string
  vault_uuid: number
  namespace: string
  access_ref: string
  scope: "asset.owner" | "asset.share"
  expiry: string
  digest: string
  condition_data: string
  access_aux_data: string
  signature: string
  proof: {
    vault_uuid: number
    caller: string
    access_ref: string
    scope: "asset.owner" | "asset.share"
    expiry: string
    namespace: string
  }
}

export type AssetCdrManifestResponse = {
  asset_id: string
  community_id: string
  access_mode: "locked"
  decision_reason: "creator" | "moderator" | "purchase_entitlement"
  delivery_ref: string
  network: "testnet"
  rpc_url: string
  dkg_source: "evm-events" | "cosmos-abci"
  comet_rpc_url: string | null
  gateway_base_url: string
  encrypted_cid: string
  encrypted_fetch_url: string | null
  vault_uuid: number
  wallet_attachment_id: string
  caller_address: string
  signer_family: "story-access-controller" | null
  signer_address: string | null
  verifier_contract: string | null
  namespace: string | null
  access_ref: string | null
  scope: "asset.owner" | "asset.share" | null
  expiry: string | null
  digest: string | null
  condition_data: string
  access_aux_data: string
  signature: string | null
  proof: AssetAccessProofResponse["proof"] | null
}

export type HandleUpgradeQuote = {
  desired_label: string
  tier: "standard" | "premium"
  price_usd: number
  eligible: boolean
  reason?: string | null
}

export type Env = {
  ENVIRONMENT?: string
  DEV_MEMORY_STORE_ENABLED?: string
  PIRATE_API_PUBLIC_ORIGIN?: string
  SELF_VERIFICATION_SCOPE?: string
  SELF_MOCK_PASSPORT?: string
  CONTROL_PLANE_DATABASE_URL?: string
  TURSO_COMMUNITY_DB_WRAP_KEY?: string
  TURSO_COMMUNITY_DB_WRAP_KEY_VERSION?: string
  LOCAL_COMMUNITY_DB_ROOT?: string
  COMMUNITY_PROVISION_OPERATOR_BASE_URL?: string
  COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN?: string
  COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS?: string
  COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION?: string
  ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION?: string
  REGISTRY_PUBLISHER_URL?: string
  REGISTRY_PUBLISHER_AUTH_TOKEN?: string
  REGISTRY_PUBLISHER_TIMEOUT_MS?: string
  VERY_VERIFY_URL?: string
  HNS_VERIFICATION_PROVIDER?: string
  HNS_RESOLVER_HOST?: string
  HNS_VERIFICATION_TIMEOUT_MS?: string
  HNS_PIRATE_NS_HOSTS?: string
  HNS_ASSUME_EXPIRY_HORIZON_SUFFICIENT?: string
  SPACES_VERIFIER_BASE_URL?: string
  SPACES_VERIFIER_AUTH_TOKEN?: string
  ALLOW_STUB_NAMESPACE_VERIFICATION?: string
  JWT_BASED_AUTH_ENABLED?: string
  JWT_BASED_AUTH_SHARED_SECRET?: string
  JWT_BASED_AUTH_ISSUERS?: string
  JWT_BASED_AUTH_AUDIENCE?: string
  AUTH_UPSTREAM_JWT_ISSUER?: string
  AUTH_UPSTREAM_JWT_AUDIENCE?: string
  AUTH_UPSTREAM_JWT_SHARED_SECRET?: string
  PIRATE_APP_JWT_PRIVATE_KEY?: string
  PIRATE_APP_JWT_PUBLIC_KEY?: string
  PIRATE_APP_JWT_ISSUER?: string
  PIRATE_APP_JWT_AUDIENCE?: string
  PIRATE_APP_JWT_TTL_SECONDS?: string
  PRIVY_APP_ID?: string
  PRIVY_APP_SECRET?: string
  PRIVY_API_URL?: string
  PRIVY_JWT_VERIFICATION_KEY?: string
  REDDIT_PROFILE_CHECK_USER_AGENT?: string
  REDDIT_PULLPUSH_BASE_URL?: string
  INTERNAL_JOB_RUNNER_TOKEN?: string
  REDDIT_IMPORT_JOB_STALE_AFTER_SECONDS?: string
  REDDIT_IMPORT_JOB_DRAIN_LIMIT?: string
  OPENROUTER_API_KEY?: string
  ELEVENLABS_API_KEY?: string
  LIT_CHIPOTLE_API_BASE_URL?: string
  LIT_CHIPOTLE_OPERATOR_API_KEY?: string
  LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY?: string
  STORY_ACCESS_CONTROLLER_PRIVATE_KEY?: string
  LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY?: string
  SONG_LYRICS_LLM_MODEL?: string
  SONG_LYRICS_TRANSLATION_TARGET_LOCALES?: string
  SONG_ENRICHMENT_DRAIN_LIMIT?: string
  SONG_ENRICHMENT_STALE_AFTER_SECONDS?: string
  SONG_PREVIEW_DRAIN_LIMIT?: string
  SONG_PREVIEW_STALE_AFTER_SECONDS?: string
  COMMUNITY_POST_PROJECTION_RECONCILE_LIMIT?: string
  SONG_ASSET_STORY_DRAIN_LIMIT?: string
  SONG_ASSET_STORY_STALE_AFTER_SECONDS?: string
  SONG_LOCKED_DELIVERY_DRAIN_LIMIT?: string
  SONG_LOCKED_DELIVERY_STALE_AFTER_SECONDS?: string
  STORY_PUBLISH_FORCE_FAIL?: string
  LOCKED_DELIVERY_FORCE_FAIL?: string
  STORY_AENEID_RPC_URL?: string
  ETHEREUM_MAINNET_RPC_URL?: string
  POLYGON_MAINNET_RPC_URL?: string
  STORY_IP_ASSET_REGISTRY_ADDRESS?: string
  STORY_SONG_IP_TOKEN_ADDRESS?: string
  STORY_ASSET_PUBLISH_COORDINATOR_ADDRESS?: string
  STORY_OPERATOR_PKP_ADDRESS?: string
  STORY_OPERATOR_PKP_PUBLIC_KEY?: string
  STORY_PUBLISH_OPERATOR_PRIVATE_KEY?: string
  STORY_OPERATOR_PUBLISH_ASSET_VERSION_ACTION_CID?: string
  STORY_ENTITLEMENT_TOKEN_ADDRESS?: string
  STORY_TOKEN_GATE_CONDITION_ADDRESS?: string
  STORY_SIGNED_ACCESS_CONDITION_ADDRESS?: string
  STORY_ACCESS_CONTROLLER_PKP_ADDRESS?: string
  STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY?: string
  STORY_ACCESS_CONTROLLER_SIGN_ACCESS_PROOF_ACTION_CID?: string
  STORY_ACCESS_PROOF_TTL_SECONDS?: string
  STORY_MARKETPLACE_SETTLEMENT_ADDRESS?: string
  STORY_SETTLEMENT_PKP_ADDRESS?: string
  STORY_SETTLEMENT_SETTLE_PURCHASE_ACTION_CID?: string
  STORY_SETTLEMENT_PRIVATE_KEY?: string
  STORY_CONTRACT_OWNER_PRIVATE_KEY?: string
  STORY_CDR_WRITER_PRIVATE_KEY?: string
  STORY_CDR_WRITE_CONDITION_ADDRESS?: string
  STORY_CDR_WRITE_CONDITION_DATA?: string
  STORY_CDR_READ_CONDITION_ADDRESS?: string
  STORY_CDR_READ_CONDITION_DATA?: string
  STORY_CDR_COMET_RPC_URL?: string
  STORY_CDR_API_BASE_URL?: string
  STORY_CDR_API_KEY?: string
  FILEBASE_S3_ACCESS_KEY?: string
  FILEBASE_S3_SECRET_KEY?: string
  FILEBASE_S3_BUCKET_MUSIC?: string
  FILEBASE_S3_ENDPOINT?: string
  FILEBASE_S3_REGION?: string
  IPFS_GATEWAY_URL?: string
  ACR_ACCESS_KEY?: string
  ACR_SECRET_KEY?: string
  ACR_CONSOLE_TOKEN?: string
  ACRCLOUD_CUSTOM_BUCKET_ID?: string
  ACRCLOUD_ENABLED?: string
  ACRCLOUD_FAIL_OPEN?: string
  ACRCLOUD_IDENTIFY_TIMEOUT_MS?: string
  ACRCLOUD_IDENTIFY_MAX_BYTES?: string
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
}

export type MediaAnalysisOutcome = "allow" | "allow_with_required_reference" | "review_required" | "blocked"

export type MediaAnalysisResult = {
  media_analysis_result_id: string
  community_id: string
  source_post_id: string | null
  source_asset_id: string | null
  outcome: MediaAnalysisOutcome
  content_safety_state: "pending" | "safe" | "sensitive" | "adult"
  age_gate_policy: "none" | "18_plus"
  trigger_sources_json: string | null
  acrcloud_music_match_json: string | null
  acrcloud_custom_match_json: string | null
  acrcloud_error_code: string | null
  acrcloud_error_message: string | null
  acrcloud_checked_at: string | null
  safety_signals_json: string | null
  authenticity_signals_json: string | null
  policy_reason_code: string | null
  policy_reason: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export type AssetDerivativeLink = {
  asset_derivative_link_id: string
  asset_id: string
  upstream_asset_id: string
  relationship_type: "remix_of" | "references_song" | "inspired_by" | "samples"
  created_at: string
}

export type RightsReviewCaseStatus = "open" | "under_review" | "resolved" | "blocked"
export type RightsReviewResolution = "clear" | "clear_with_upstream_refs" | "block" | "needs_more_evidence" | null

export type RightsReviewCase = {
  rights_review_case_id: string
  subject_type: "asset" | "live_room" | "replay_asset"
  subject_id: string
  community_id: string
  status: RightsReviewCaseStatus
  trigger_source: "acrcloud_match" | "manual_report" | "operator_escalation"
  analysis_result_ref: string | null
  submitted_evidence_refs_json: string | null
  resolution: RightsReviewResolution
  resolver_user_id: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}
