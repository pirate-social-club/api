export type {
  Asset,
  AssetAccessResponse,
  AuthProof,
  AgentHandle,
  AgentHandleStatus,
  CommunityCreateAcceptedResponse,
  CommunityListing,
  CommunityListingListResponse,
  CommunityMoneyPolicy,
  CommunityPurchase,
  CommunityPurchaseListResponse,
  CommunityPurchaseQuote,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
  CommunityPricingPolicy,
  CompleteNamespaceVerificationSessionRequest,
	  CompleteVerificationSessionRequest,
	  RefreshPassportWalletScoreRequest,
	  RefreshPassportWalletScoreResponse,
  CommentVoteResponse,
  CreateModerationActionRequest,
  CreateUserReportRequest,
  CreateCommunityRequest,
  CreateCommunityListingRequest,
  CreateCommentRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  ClaimableRoyaltiesResponse,
  DismissTaskRequest,
  ErrorResponse,
  GateFailureDetails,
  HomeFeedCommunitySummary,
  HomeFeedItem,
  HomeFeedResponse,
  HomeFeedSort,
  GlobalHandle,
  Job,
  JoinEligibility,
  LinkedHandle,
  MarkNotificationsReadRequest,
  MembershipRequestListResponse,
  MembershipRequestStatus,
  MembershipRequestSummary,
  MembershipGateSummary,
  ModerationAction,
  ModerationCase,
  ModerationCaseDetail,
  ModerationCaseListResponse,
  ModerationSignal,
  NamespaceVerification,
  NamespaceVerificationAssertions,
  NamespaceVerificationCapabilities,
  NamespaceVerificationSession,
  NotificationEvent,
  NotificationEventType,
  NotificationFeedItem,
  NotificationFeedResponse,
  NotificationReceipt,
  NotificationSummary,
  NotificationTasksResponse,
  OnboardingStatus,
  Profile,
  PublicAgentResolution,
  RedditImportSummary,
  RedditVerification,
  RequestedVerificationCapability,
  RoyaltyActivityItem,
  RoyaltyActivityResponse,
  RoyaltyClaimHistoryResponse,
  RoyaltyClaimRecord,
  RoyaltyClaimRecordRequest,
  VerificationRequirement,
  SelfVerificationDisclosures,
  SelfVerificationLaunch,
  SessionExchangeRequest,
  SessionExchangeResponse,
  SongArtifactBundle,
  SongArtifactUpload,
  StartNamespaceVerificationSessionRequest,
  StartVerificationSessionRequest,
  UpdateCommunityListingRequest,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
  UpdateAgentHandleRequest,
  UserReport,
  UserTask,
  UserTaskStatus,
  UserTaskType,
  VerificationCapabilities,
  VerificationIntent,
  VerificationSession,
  VerificationSessionLaunch,
  VerySessionBinding,
  VeryWidgetLaunch,
  WalletAttachmentSummary,
} from "@pirate/api-contracts"

import type {
  Community as ContractCommunity,
  CommunityPreview as ContractCommunityPreview,
  CommunityRoleSummary as ContractCommunityRoleSummary,
  LocalizedPostResponse as ContractLocalizedPostResponse,
  Post as ContractPost,
  CommunityMoneyPolicy,
  VerificationCapabilities,
} from "@pirate/api-contracts"
import type { GatePolicy } from "./lib/communities/membership/gate-types"

type AgentOwnershipProvider = ContractCommunity["accepted_agent_ownership_providers"][number]
type CommunityAgentResolutionOrigin = ContractCommunity["human_verification_lane_origin"]
type CommunityContentAuthenticityPolicy = ContractCommunity["content_authenticity_policy"]
type CommunityContentAuthenticityDetectionPolicy = ContractCommunity["content_authenticity_detection_policy"]
type CommunityMarketContextPolicy = ContractCommunity["market_context_policy"]
type CommunitySourcePolicy = ContractCommunity["source_policy"]
type CommunityCaptureEditPolicy = ContractCommunity["capture_edit_policy"]
type CommunityAdultContentPolicy = ContractCommunity["adult_content_policy"]
type CommunityGraphicContentPolicy = ContractCommunity["graphic_content_policy"]
type CommunityMotionMediaPolicy = ContractCommunity["motion_media_policy"]
type CommunityLanguagePolicy = ContractCommunity["language_policy"]
type CommunityCivilityPolicy = ContractCommunity["civility_policy"]
type CommunityProvenancePolicy = ContractCommunity["provenance_policy"]
type CommunityPromotionPolicy = ContractCommunity["promotion_policy"]
type CommunityLabelPolicy = NonNullable<ContractCommunity["label_policy"]>
type CommunityProfile = NonNullable<ContractCommunity["community_profile"]>
type CommunityGovernanceBackend = NonNullable<ContractCommunity["governance_backend"]>
type CommunityReferenceLinkPublic = NonNullable<ContractCommunity["reference_links"]>[number]
type CommunityRule = ContractCommunityPreview["rules"][number]
type DisclosedQualifierSnapshot = NonNullable<ContractPost["disclosed_qualifiers_json"]>[number]
type DonationPartnerSummary = NonNullable<ContractCommunity["donation_partner"]>
type HumanVerificationLane = ContractCommunity["human_verification_lane"]
type MarketContextSummary = NonNullable<ContractLocalizedPostResponse["market_context"]>
type MediaDescriptor = NonNullable<ContractPost["media_refs"]>[number]
type PostCreatorRelation = NonNullable<ContractPost["creator_relation"]>
type PostEmbed = NonNullable<ContractPost["embeds"]>[number]
type PromotionDisclosure = NonNullable<ContractPost["promotion_disclosure"]>
type ReplyQuotaByTrustTier = NonNullable<ContractCommunity["reply_quota_by_trust_tier"]>
type RootPostQuotaByTrustTier = NonNullable<ContractCommunity["root_post_quota_by_trust_tier"]>

export type CommunityRoleSummary = ContractCommunityRoleSummary
type MembershipGateSummary = ContractCommunityPreview["membership_gate_summaries"][number]

export type AgentActionProof = {
  nonce: string
  signed_at: string
  canonical_request_hash: string
  signature: string
}

export type User = {
  user_id: string
  community_posting_state?: {
    community_ref?: string
    community_id?: string
    has_created_text_post?: boolean
  } | null
  primary_wallet_attachment_id?: string | null
  verification_state: "unverified" | "pending" | "verified" | "reverification_required"
  capability_provider?: "self" | "very" | null
  verification_capabilities: VerificationCapabilities
  verified_at?: string | null
  created_at: string
  updated_at: string
}

export type Comment = {
  comment_id: string
  community_id: string
  thread_root_post_id: string
  parent_comment_id: string | null
  author_user_id: string | null
  authorship_mode: "human_direct" | "user_agent"
  agent_id?: string | null
  agent_ownership_record_id?: string | null
  identity_mode: "public" | "anonymous"
  anonymous_scope: "community_stable" | "thread_stable" | null
  anonymous_label: string | null
  agent_handle_snapshot?: string | null
  agent_display_name_snapshot?: string | null
  agent_owner_handle_snapshot?: string | null
  agent_ownership_provider_snapshot?: AgentOwnershipProvider | null
  body: string | null
  status: "published" | "hidden" | "removed" | "deleted"
  depth: number
  direct_reply_count: number
  descendant_count: number
  upvote_count: number
  downvote_count: number
  score: number
  last_reply_at: string | null
  content_hash: string | null
  swarm_body_ref: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
}

export type CommentListItem = {
  comment: Comment
  viewer_vote: -1 | 1 | null
  resolved_locale: string
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked"
  machine_translated: boolean
  translated_body?: string | null
  source_hash: string
}

export type CommentThreadSnapshot = {
  thread_root_post_id: string
  snapshot_seq: number
  published_through_comment_created_at: string
  comment_count: number
  swarm_manifest_ref: string
  swarm_feed_ref: string | null
  created_at: string
}

export type CommentListResponse = {
  items: Array<CommentListItem>
  next_cursor: string | null
  thread_snapshot: CommentThreadSnapshot | null
}

export type CommentContext = {
  ancestors: Array<CommentListItem>
  comment: CommentListItem
  replies: Array<CommentListItem>
  next_replies_cursor: string | null
  thread_snapshot: CommentThreadSnapshot | null
}

export type PostLabel = {
  label_id: string
  label: string
  color_token?: string | null
  status: "active" | "archived"
}

export type PostLabelAssignmentStatus = "pending" | "assigned" | "failed" | "skipped"

export type Post = {
  post_id: string
  community_id: string
  author_user_id?: string | null
  authorship_mode: "human_direct" | "user_agent"
  agent_id?: string | null
  agent_ownership_record_id?: string | null
  identity_mode: "public" | "anonymous"
  anonymous_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  anonymous_label?: string | null
  agent_handle_snapshot?: string | null
  agent_display_name_snapshot?: string | null
  agent_owner_handle_snapshot?: string | null
  agent_ownership_provider_snapshot?: string | null
  disclosed_qualifiers_json?: Array<DisclosedQualifierSnapshot> | null
  label_id?: string | null
  post_type: "text" | "image" | "video" | "link" | "song"
  status: "draft" | "published" | "hidden" | "removed" | "deleted"
  visibility: "public" | "members_only"
  title?: string | null
  body?: string | null
  caption?: string | null
  lyrics?: string | null
  link_url?: string | null
  link_og_image_url?: string | null
  link_og_title?: string | null
  embeds?: Array<PostEmbed> | null
  media_refs?: Array<MediaDescriptor>
  creator_relation?: PostCreatorRelation | null
  promotion_disclosure?: PromotionDisclosure | null
  source_language?: string | null
  translation_policy?: "none" | "machine_allowed" | "human_only" | "hybrid" | null
  access_mode?: "public" | "locked" | null
  asset_id?: string | null
  song_artifact_bundle_id?: string | null
  parent_post_id?: string | null
  song_mode?: "original" | "remix" | null
  rights_basis?: "none" | "original" | "derivative" | "attribution_only" | null
  upstream_asset_refs?: Array<string> | null
  analysis_state: "pending" | "allow" | "allow_with_required_reference" | "review_required" | "blocked"
  analysis_result_ref?: string | null
  content_safety_state: "pending" | "safe" | "sensitive" | "adult"
  age_gate_policy: "none" | "18_plus"
  created_at: string
  updated_at: string
  label_assignment_status?: PostLabelAssignmentStatus | null
  label_assigned_by?: "moderator" | "ai" | null
  label_assigned_at?: string | null
  label_ai_confidence?: number | null
  label_assignment_error?: string | null
  label_assignment_model?: string | null
  label_assignment_result_json?: Record<string, unknown> | null
}

type CreatePostRequestBase = {
  idempotency_key: string
  authorship_mode?: "human_direct" | "user_agent"
  agent_id?: string | null
  agent_action_proof?: AgentActionProof | null
  identity_mode?: "public" | "anonymous"
  anonymous_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  disclosed_qualifier_ids?: Array<string> | null
  parent_post_id?: string | null
  label_id?: string | null
  label_assignment_status?: PostLabelAssignmentStatus | null
  label_assigned_by?: "moderator" | "ai" | null
  label_assigned_at?: string | null
  label_ai_confidence?: number | null
  label_assignment_error?: string | null
  label_assignment_model?: string | null
  label_assignment_result_json?: Record<string, unknown> | null
  body?: string | null
  caption?: string | null
  link_url?: string | null
  media_refs?: Array<MediaDescriptor>
  creator_relation?: PostCreatorRelation | null
  promotion_disclosure?: PromotionDisclosure | null
  translation_policy?: "none" | "machine_allowed" | "human_only" | "hybrid"
  visibility?: "public" | "members_only"
  access_mode?: "public" | "locked" | null
  asset_id?: string | null
  song_artifact_bundle_id?: string | null
  song_mode?: "original" | "remix" | null
  rights_basis?: "none" | "original" | "derivative" | "attribution_only" | null
  upstream_asset_refs?: Array<string> | null
  license_preset?: "non-commercial" | "commercial-use" | "commercial-remix" | null
  commercial_rev_share_pct?: number | null
  lyrics?: string | null
}

export type CreatePostRequest = CreatePostRequestBase & {
  title?: string | null
} & (
  | { post_type: "text" }
  | { post_type: "image"; media_refs: Array<MediaDescriptor> }
  | { post_type: "video"; media_refs: Array<MediaDescriptor> }
  | { post_type: "link"; link_url: string }
  | { post_type: "song"; identity_mode: "public"; media_refs?: Array<MediaDescriptor> }
)

export type LocalizedPostResponse = {
  post: Post
  author_community_role?: "owner" | "moderator" | null
  thread_snapshot: CommentThreadSnapshot | null
  market_context?: MarketContextSummary | null
  label?: PostLabel | null
  upvote_count: number
  downvote_count: number
  like_count: number
  comment_count?: number
  viewer_vote: -1 | 1 | null
  viewer_reaction_kinds: Array<"like">
  resolved_locale: string
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked"
  machine_translated: boolean
  translated_body?: string | null
  translated_title?: string | null
  translated_caption?: string | null
  source_hash: string
}

export type CommunityTextLocalizationItem = {
  field_key: string
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked"
  machine_translated: boolean
  translated_value?: string | null
  source_hash: string
}

export type CommunityTextLocalization = {
  resolved_locale: string
  items: CommunityTextLocalizationItem[]
}

export type Community = {
  community_id: string
  display_name: string
  description?: string | null
  avatar_ref?: string | null
  banner_ref?: string | null
  namespace_verification_id?: string | null
  route_slug?: string | null
  pending_namespace_verification_session_id?: string | null
  status: "draft" | "active" | "frozen" | "archived" | "deleted"
  provisioning_state: "requested" | "provisioning" | "active" | "rotation_required" | "error"
  artist_identity_id?: string | null
  community_agent_user_id?: string | null
  membership_mode: "open" | "request" | "gated"
  allow_anonymous_identity: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  human_verification_lane: HumanVerificationLane
  human_verification_lane_origin: CommunityAgentResolutionOrigin
  allowed_disclosed_qualifiers?: Array<string> | null
  allow_qualifiers_on_anonymous_posts?: boolean | null
  root_post_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null
  reply_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null
  anonymous_posting_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null
  root_post_quota_by_trust_tier?: RootPostQuotaByTrustTier | null
  reply_quota_by_trust_tier?: ReplyQuotaByTrustTier | null
  probation_window_days?: number | null
  link_post_policy?: "allow" | "require_established" | null
  default_age_gate_policy?: "none" | "18_plus"
  agent_posting_policy: "disallow" | "review" | "allow_with_disclosure" | "allow"
  agent_posting_scope: "replies_only" | "top_level_and_replies"
  agent_daily_post_cap?: number | null
  agent_daily_reply_cap?: number | null
  agent_min_owner_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null
  agent_owner_active_limit?: number | null
  accepted_agent_ownership_providers: Array<AgentOwnershipProvider>
  accepted_agent_ownership_providers_origin: CommunityAgentResolutionOrigin
  civic_scale_tier?: "club" | "village" | "town" | "city" | "state"
  donation_policy_mode: "none" | "optional_creator_sidecar"
  donation_partner_status: "unconfigured" | "active" | "paused"
  donation_partner_id?: string | null
  donation_partner?: DonationPartnerSummary | null
  money_policy: CommunityMoneyPolicy
  content_authenticity_policy: CommunityContentAuthenticityPolicy
  content_authenticity_detection_policy: CommunityContentAuthenticityDetectionPolicy
  market_context_policy: CommunityMarketContextPolicy
  source_policy: CommunitySourcePolicy
  capture_edit_policy: CommunityCaptureEditPolicy
  adult_content_policy: CommunityAdultContentPolicy
  graphic_content_policy: CommunityGraphicContentPolicy
  motion_media_policy: CommunityMotionMediaPolicy
  language_policy: CommunityLanguagePolicy
  civility_policy: CommunityCivilityPolicy
  openai_moderation_settings?: {
    scan_titles?: boolean
    scan_post_bodies?: boolean
    scan_captions?: boolean
    scan_link_preview_text?: boolean
    scan_images?: boolean
  } | null
  provenance_policy: CommunityProvenancePolicy
  promotion_policy: CommunityPromotionPolicy
  label_policy?: CommunityLabelPolicy | null
  community_profile?: CommunityProfile | null
  reference_links?: Array<CommunityReferenceLinkPublic> | null
  community_stage?: "initial"
  member_count?: number | null
  qualified_member_count?: number | null
  stage_entered_at?: string | null
  governance_mode: "centralized" | "multisig" | "majeur"
  governance_backend?: CommunityGovernanceBackend | null
  gate_policy?: GatePolicy | null
  created_by_user_id: string
  created_at: string
  updated_at: string
  localized_text?: CommunityTextLocalization | null
}

export type CommunityPreview = {
  community_id: string
  namespace_verification_id?: string | null
  route_slug?: string | null
  display_name: string
  description?: string | null
  localized_text?: CommunityTextLocalization | null
  avatar_ref?: string | null
  banner_ref?: string | null
  membership_mode: "open" | "request" | "gated"
  allow_anonymous_identity?: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  allowed_disclosed_qualifiers?: Array<string> | null
  allow_qualifiers_on_anonymous_posts?: boolean | null
  human_verification_lane: HumanVerificationLane
  member_count?: number | null
  follower_count?: number | null
  donation_policy_mode?: "none" | "optional_creator_sidecar" | null
  donation_partner_id?: string | null
  donation_partner?: DonationPartnerSummary | null
  owner?: CommunityRoleSummary | null
  moderators: Array<CommunityRoleSummary>
  reference_links?: Array<CommunityReferenceLinkPublic> | null
  membership_gate_summaries: Array<MembershipGateSummary>
  rules: Array<CommunityRule>
  viewer_membership_status?: "member" | "not_member" | "banned" | null
  viewer_following?: boolean | null
  created_at: string
}

export type HandleUpgradeQuote = {
  desired_label: string
  tier: "standard" | "premium"
  price_cents: number
  eligible: boolean
  reason?: string | null
  benefit_source?: "verified_reddit_username" | "reddit_reputation" | null
  reputation_discount_cents?: number | null
  claim_reason?: string | null
}

export type Env = {
  // Runtime
  ENVIRONMENT?: string
  DEV_MEMORY_STORE_ENABLED?: string
  CONTROL_PLANE_DATABASE_URL?: string
  CORS_ALLOWED_ORIGINS?: string
  PIRATE_ADMIN_TOKEN?: string
  SENTRY_DSN?: string

  // Analytics
  ANALYTICS_ENABLED?: string
  ANALYTICS_HMAC_SECRET?: string
  TINYBIRD_HOST?: string
  TINYBIRD_INGEST_TOKEN?: string
  TINYBIRD_EVENTS_DATASOURCE?: string

  // Community databases and provisioning
  TURSO_COMMUNITY_DB_WRAP_KEY?: string
  TURSO_COMMUNITY_DB_WRAP_KEY_VERSION?: string
  LOCAL_COMMUNITY_DB_ROOT?: string
  COMMUNITY_PROVISION_OPERATOR_BASE_URL?: string
  COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN?: string
  COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS?: string
  COMMUNITY_PROVISION_EXPECTED_ORGANIZATION_SLUG?: string
  COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION?: string
  COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS?: string

  // Auth and identity
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
  VERY_API_URL?: string
  VERY_APP_ID?: string
  VERY_VERIFY_URL?: string
  VERY_TRUST_BRIDGE_COMPLETION_ON_VERIFIER_5XX?: string
  VERY_TRUST_LOCAL_WIDGET_COMPLETION?: string
  VERIFICATION_DEBUG_LOGS?: string
  PLATFORM_APPROVED_KYA_PROVIDERS?: string
  CLAWKEY_API_URL?: string
  SELF_APP_NAME?: string
  SELF_ENDPOINT?: string
  SELF_ENDPOINT_TYPE?: string
  VERY_BRIDGE_API_URL?: string
  PASSPORT_API_URL?: string
  PASSPORT_API_KEY?: string
  PASSPORT_SCORER_ID?: string

  // Media storage
  FILEBASE_S3_ACCESS_KEY?: string
  FILEBASE_S3_SECRET_KEY?: string
  FILEBASE_S3_BUCKET_MUSIC?: string
  FILEBASE_S3_ENDPOINT?: string
  FILEBASE_S3_REGION?: string
  FILEBASE_MEDIA_BUCKET?: string
  PIRATE_API_PUBLIC_ORIGIN?: string
  IPFS_GATEWAY_URL?: string
  SWARM_BEE_API_URL?: string
  SWARM_POSTAGE_BATCH_ID?: string
  SWARM_FEED_PRIVATE_KEY?: string
  SWARM_FEED_TOPIC_NAMESPACE?: string

  // EVM and commerce
  ETHEREUM_RPC_URL?: string
  COURTYARD_API_URL?: string
  COURTYARD_INVENTORY_CACHE_TTL_MS?: string
  BASE_MAINNET_RPC_URL?: string
  BASE_SEPOLIA_RPC_URL?: string
  PIRATE_CHECKOUT_OPERATOR_ADDRESS?: string
  PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY?: string
  PIRATE_CHECKOUT_RPC_URL?: string
  PIRATE_CHECKOUT_SOURCE_CHAIN_ID?: string
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS?: string
  PIRATE_CHECKOUT_TX_WAIT_TIMEOUT_MS?: string

  // Story and song processing
  STORY_CHAIN_ID?: string
  STORY_RPC_URL?: string
  STORY_RPC_FALLBACK_URLS?: string
  STORY_ROYALTY_SPG_NFT_CONTRACT?: string
  STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT?: string
  STORY_ROYALTY_DEFAULT_MINTING_FEE_WEI?: string
  STORY_ROYALTY_MAX_LICENSE_TOKENS?: string
  STORY_ROYALTY_POLICY_LAP_ADDRESS?: string
  COMMUNITY_JOB_WORKER_INTERVAL_MS?: string
  COMMUNITY_JOB_WORKER_MAX_JOBS_PER_COMMUNITY?: string
  COMMUNITY_JOB_WORKER_MAX_COMMUNITIES_PER_TICK?: string
  SONG_PREVIEW_FFMPEG_BIN?: string
  SONG_PREVIEW_FFPROBE_BIN?: string
  STORY_TX_WAIT_TIMEOUT_MS?: string
  STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI?: string
  STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI?: string
  STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI?: string
  STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI?: string
  STORY_DIRECT_TX_GAS_LIMIT_MAX?: string
  STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS?: string
  STORY_RUNTIME_PRIVATE_KEY?: string
  STORY_OPERATOR_PRIVATE_KEY?: string
  STORY_OPERATOR_PKP_ADDRESS?: string
  STORY_OPERATOR_PKP_PUBLIC_KEY?: string
  STORY_OPERATOR_ACTION_CID_PUBLISH_ASSET_VERSION?: string
  LIT_CHIPOTLE_API_BASE_URL?: string
  LIT_CHIPOTLE_OPERATOR_API_KEY?: string
  STORY_CDR_WRITER_PRIVATE_KEY?: string
  STORY_CDR_WRITER_PKP_ADDRESS?: string
  STORY_CDR_WRITER_PKP_PUBLIC_KEY?: string
  STORY_CDR_WRITER_ACTION_CID_ALLOCATE_WRITE?: string
  LIT_CHIPOTLE_CDR_WRITER_API_KEY?: string
  STORY_ACCESS_CONTROLLER_PRIVATE_KEY?: string
  STORY_ACCESS_CONTROLLER_PKP_ADDRESS?: string
  STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY?: string
  STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF?: string
  LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ID?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY?: string
  LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY?: string
  STORY_SETTLEMENT_ACTION_CID_SETTLE?: string
  STORY_SETTLEMENT_ACTION_CID_ROYALTY_SYNC?: string

  // Payouts and funding
  ENDAOMENT_PAYOUT_PRIVATE_KEY?: string
  ENDAOMENT_RPC_URL?: string
  ENDAOMENT_CHAIN_ID?: string
  ENDAOMENT_USDC_TOKEN_ADDRESS?: string
  ENDAOMENT_REGISTRY_ADDRESS?: string
  ENDAOMENT_TX_WAIT_TIMEOUT_MS?: string
  STORY_CONTRACT_OWNER_PRIVATE_KEY?: string
  STORY_RUNTIME_FUNDER_PRIVATE_KEY?: string

  // AI and external analysis
  OPENAI_API_KEY?: string
  OPENAI_MODERATION_BASE_URL?: string
  OPENAI_MODERATION_MODEL?: string
  OPENAI_MODERATION_SEXUAL_MINORS_BLOCK_THRESHOLD?: string
  OPENAI_MODERATION_TIMEOUT_MS?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  OPENROUTER_MODEL?: string
  OPENROUTER_TIMEOUT_MS?: string
  OPENROUTER_TRANSLATION_MODEL?: string
  OPENROUTER_TRANSLATION_TIMEOUT_MS?: string
  OPENROUTER_LABELING_MODEL?: string
  OPENROUTER_LABELING_TIMEOUT_MS?: string
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_FORCE_ALIGNMENT_URL?: string
  ELEVENLABS_TIMEOUT_MS?: string
  ACRCLOUD_ACCESS_KEY?: string
  ACRCLOUD_ACCESS_SECRET?: string
  ACRCLOUD_HOST?: string
  ACRCLOUD_IDENTIFY_PATH?: string
  ACRCLOUD_TIMEOUT_MS?: string
  ACRCLOUD_PERSONAL_ACCESS_TOKEN?: string
  ACRCLOUD_BUCKET_ID?: string
  ACRCLOUD_CONSOLE_BASE_URL?: string

  // Namespace verifiers
  SPACES_VERIFIER_BASE_URL?: string
  SPACES_VERIFIER_AUTH_TOKEN?: string
  SPACES_VERIFIER_CHALLENGE_DOMAIN?: string
  HNS_VERIFIER_BASE_URL?: string
  HNS_VERIFIER_AUTH_TOKEN?: string
  HNS_AUTO_PROVISION_ROOTS?: string
  HNS_CHALLENGE_TTL_HOURS?: string
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
}
