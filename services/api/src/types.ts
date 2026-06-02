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
  CommunityHandle,
  CommunityHandleClaimRequest,
  CommunityHandleListResponse,
  CommunityHandleMeResponse,
  CommunityHandleProtocolIssuance,
  CommunityHandleStatusResponse,
  CommunityHandlePolicy,
  CommunityHandlePolicySettings,
  CommunityHandleQuote,
  CommunityHandleQuoteRequest,
  CommunityHandleReserveRequest,
  CommunityHandleRevokeRequest,
  UpdateCommunityHandlePolicyRequest,
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
  SongArtifactBundleListResponse,
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

export type DerivativeSourceKind = "song" | "video"

export type DerivativeSource = {
  id: string
  object: "derivative_source"
  community: string
  asset: string
  source_ref: string
  title: string
  kind: DerivativeSourceKind
  story_ip: string
  story_license_terms: string
  license_preset?: Asset["license_preset"] | null
  commercial_rev_share_pct?: number | null
  creator_user: string
  creator_handle?: string | null
  creator_display_name?: string | null
}

export type DerivativeSourceListResponse = {
  items: DerivativeSource[]
  next_cursor: string | null
}

export type PostDerivativeSource = {
  source_ref: string
  title: string
  kind: DerivativeSourceKind
  relationship_type: "remix_of" | "references_song" | "references_video" | "inspired_by" | "samples"
  community?: string | null
  asset?: string | null
  source_post?: string | null
  story_ip?: string | null
  story_license_terms?: string | null
  license_preset?: Asset["license_preset"] | null
  commercial_rev_share_pct?: number | null
  creator_user?: string | null
  creator_handle?: string | null
  creator_display_name?: string | null
}

import type {
  Asset,
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
type CommunityVisualPolicySettings = ContractCommunity["visual_policy_settings"]
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
  authorship_mode: "human_direct" | "user_agent" | "guest"
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
  media_refs?: Array<MediaDescriptor>
  status: "published" | "hidden" | "removed" | "deleted"
  replies_locked?: boolean
  replies_locked_at?: string | null
  replies_locked_by_user_id?: string | null
  replies_lock_reason?: string | null
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
  viewer_can_delete?: boolean
  resolved_locale: string
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked"
  machine_translated: boolean
  translated_body?: string | null
  source_hash: string
}

export type LocalizedPostEmbedTranslation = {
  embed_key: string
  translated_question?: string | null
  translated_title?: string | null
  translated_outcomes?: Array<{
    label: string
    translated_label: string | null
    source_hash: string
  }> | null
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

export type SongPresentation = {
  title: string | null
  cover_art_ref: string | null
  duration_ms: number | null
}

export type CrosspostSourceStatus = "available" | "deleted" | "removed" | "unavailable"

export type CrosspostSource = {
  status: CrosspostSourceStatus
  post_id: string
  community_id: string
  captured_at?: string | null
  post_type?: "text" | "image" | "video" | "link" | "song" | null
  title?: string | null
  community_label?: string | null
  community_route_slug?: string | null
  author_user_id?: string | null
  author_label?: string | null
  thumbnail_ref?: string | null
}

export type PostEventStatus = "scheduled" | "canceled" | "postponed" | "ended"

export type PostEventPlace = {
  label: string
  address?: string | null
  lat: number
  lon: number
  source: "geoapify" | "manual"
  providerPlaceId?: string | null
  countryCode?: string | null
  city?: string | null
}

export type PostEvent = {
  starts_at: number
  ends_at?: number | null
  timezone: string
  location_name?: string | null
  address?: string | null
  is_online?: boolean | null
  event_url?: string | null
  status?: PostEventStatus | null
  place?: PostEventPlace | null
}

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
  post_type: "text" | "image" | "video" | "link" | "song" | "crosspost"
  status: "draft" | "published" | "hidden" | "removed" | "deleted"
  comments_locked?: boolean
  comments_locked_at?: string | null
  comments_locked_by_user_id?: string | null
  comments_lock_reason?: string | null
  visibility: "public" | "members_only"
  title?: string | null
  body?: string | null
  caption?: string | null
  lyrics?: string | null
  link_url?: string | null
  link_og_image_url?: string | null
  link_og_title?: string | null
  link_enrichment_snapshot_json?: Record<string, unknown> | null
  link_enrichment_synced_at?: string | null
  event?: PostEvent | null
  embeds?: Array<PostEmbed> | null
  media_refs?: Array<MediaDescriptor>
  creator_relation?: PostCreatorRelation | null
  promotion_disclosure?: PromotionDisclosure | null
  source_language?: string | null
  translation_policy?: "none" | "machine_allowed" | "human_only" | "hybrid" | null
  access_mode?: "public" | "locked" | null
  asset_id?: string | null
  anchor_live_room_id?: string | null
  anchor_live_room_status?: "scheduled" | "live" | "ended" | "canceled" | null
  song_artifact_bundle_id?: string | null
  song_title?: string | null
  song_annotations_url?: string | null
  song_cover_art_ref?: string | null
  song_duration_ms?: number | null
  parent_post_id?: string | null
  crosspost_source?: CrosspostSource | null
  song_mode?: "original" | "remix" | null
  rights_basis?: "none" | "original" | "derivative" | "attribution_only" | null
  upstream_asset_refs?: Array<string> | null
  analysis_state: "pending" | "allow" | "allow_with_required_reference" | "review_required" | "blocked"
  analysis_result_ref?: string | null
  content_safety_state: "pending" | "safe" | "sensitive" | "adult"
  age_gate_policy: "none" | "18_plus"
  asset_story?: {
    story_ip: string | null
    story_royalty_registration_status: "none" | "pending" | "registered" | "failed"
  } | null
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
  song_artifact_bundle?: string | null
  song_mode?: "original" | "remix" | null
  rights_basis?: "none" | "original" | "derivative" | "attribution_only" | null
  upstream_asset_refs?: Array<string> | null
  license_preset?: "non-commercial" | "commercial-use" | "commercial-remix" | null
  commercial_rev_share_pct?: number | null
  lyrics?: string | null
  source_post?: string | null
  source_community?: string | null
  crosspost_source?: CrosspostSource | null
  event?: PostEvent | null
}

export type CreatePostRequest = CreatePostRequestBase & {
  title?: string | null
} & (
  | { post_type: "text" }
  | { post_type: "image"; media_refs: Array<MediaDescriptor> }
  | { post_type: "video"; media_refs: Array<MediaDescriptor> }
  | { post_type: "link"; link_url: string }
  | { post_type: "song"; identity_mode: "public"; media_refs?: Array<MediaDescriptor> }
  | { post_type: "crosspost"; title: string; source_post: string; source_community: string }
)

export type LocalizedPostResponse = {
  post: Post
  author_community_role?: "owner" | "moderator" | null
  thread_snapshot: CommentThreadSnapshot | null
  market_context?: MarketContextSummary | null
  label?: PostLabel | null
  song_presentation?: SongPresentation | null
  asset_story?: {
    story_ip: string | null
    story_royalty_registration_status: "none" | "pending" | "registered" | "failed"
  } | null
  derivative_sources?: PostDerivativeSource[] | null
  upvote_count: number
  downvote_count: number
  like_count: number
  comment_count?: number
  viewer_vote: -1 | 1 | null
  viewer_is_author?: boolean
  viewer_reaction_kinds: Array<"like">
  age_gate_viewer_state?: "proof_required" | "verified_allowed" | null
  resolved_locale: string
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked"
  machine_translated: boolean
  translated_body?: string | null
  translated_title?: string | null
  translated_caption?: string | null
  translated_embeds?: Array<LocalizedPostEmbedTranslation> | null
  source_hash: string
}

export type ProfileActivityTab = "overview" | "posts" | "comments"

export type ProfileActivityPostPage = {
  kind: "post"
  post: LocalizedPostResponse
  community: CommunityPreview
  created_at: string
}

export type ProfileActivityCommentPage = {
  kind: "comment"
  comment: CommentListItem
  thread_root_post: LocalizedPostResponse
  community: CommunityPreview
  created_at: string
}

export type ProfileActivityItem = ProfileActivityPostPage | ProfileActivityCommentPage

export type ProfileActivityResponse = {
  tab: ProfileActivityTab
  posts: ProfileActivityPostPage[]
  comments: ProfileActivityCommentPage[]
  overview_items: ProfileActivityItem[]
  next_cursor: string | null
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
  store_url?: string | null
  store_label?: string | null
  country_code?: string | null
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
  guest_comment_policy: "disallow" | "altcha_required"
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
  visual_policy_settings: CommunityVisualPolicySettings
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
  store_url?: string | null
  store_label?: string | null
  country_code?: string | null
  membership_mode: "open" | "request" | "gated"
  allow_anonymous_identity?: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  guest_comment_policy?: "disallow" | "altcha_required"
  agent_posting_policy?: "disallow" | "review" | "allow_with_disclosure" | "allow"
  agent_posting_scope?: "replies_only" | "top_level_and_replies"
  agent_daily_post_cap?: number | null
  agent_daily_reply_cap?: number | null
  accepted_agent_ownership_providers?: Array<AgentOwnershipProvider>
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
  gate_match_mode?: "all" | "any" | null
  rules: Array<CommunityRule>
  viewer_membership_status?: "member" | "not_member" | "banned" | null
  viewer_community_role?: "owner" | "admin" | "moderator" | null
  viewer_following?: boolean | null
  created_at: string
}

export type HandleUpgradeQuote = {
  quote?: string | null
  desired_label: string
  tier: "standard" | "premium"
  price_cents: number
  currency?: "USD"
  eligible: boolean
  reason?: string | null
  policy_version?: string | null
  pricing_tier?: string | null
  quote_ttl_seconds?: number | null
  quoted_at?: number | null
  expires_at?: number | null
  payment_instructions?: {
    chain: {
      chain_namespace: "eip155"
      chain_id: number
      display_name: string
    }
    token_address: string
    recipient_address: string
    amount_atomic: string
    amount_display: string
  } | null
  benefit_source?: "verified_reddit_username" | "reddit_reputation" | null
  reputation_discount_cents?: number | null
  claim_reason?: string | null
}

export type GlobalHandlePaidClaimRequest = {
  quote: string
  settlement_wallet_attachment?: string | null
  funding_tx_ref?: string | null
}

export type { Env } from "./env"

export type UpstreamWalletIdentity = {
  chainNamespace: string
  walletAddress: string
  walletAddressNormalized: string
  scriptPubkeyHex?: string | null
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy" | "telegram"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
  wallets?: UpstreamWalletIdentity[]
  selectedWallet?: UpstreamWalletIdentity | null
}
