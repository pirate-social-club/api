export type {
  Asset,
  AssetAccessResponse,
  AuthProof,
  AgentActionProof,
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
  Comment,
  CommentContext,
  CommentListItem,
  CommentListResponse,
  CommentThreadSnapshot,
  CommentVoteResponse,
  CreateModerationActionRequest,
  CreateUserReportRequest,
  CreateCommunityRequest,
  CreateCommunityListingRequest,
  CreateCommentRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
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
  LocalizedPostResponse,
  MarkNotificationsReadRequest,
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
  User,
  UserReport,
  UserTask,
  UserTaskStatus,
  UserTaskType,
  VerificationCapabilities,
  VerificationIntent,
  VerificationSession,
  VerificationSessionLaunch,
  VeryWidgetLaunch,
  WalletAttachmentSummary,
} from "@pirate/api-contracts"

import type {
  Community as ContractCommunity,
  CommunityPreview as ContractCommunityPreview,
  CreatePostRequest as ContractCreatePostRequest,
  Post as ContractPost,
} from "@pirate/api-contracts"

export type PostLabel = {
  label_id: string
  label: string
  color_token?: string | null
  status: "active" | "archived"
}

export type PostLabelAssignmentStatus = "pending" | "assigned" | "failed" | "skipped"

export type Post = ContractPost & {
  label_assignment_status?: PostLabelAssignmentStatus | null
  label_assigned_by?: "moderator" | "ai" | null
  label_assigned_at?: string | null
  label_ai_confidence?: number | null
  label_assignment_error?: string | null
  label_assignment_model?: string | null
  label_assignment_result_json?: Record<string, unknown> | null
}

export type CreatePostRequest = ContractCreatePostRequest & {
  title?: string | null
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

export type Community = ContractCommunity & {
  localized_text?: CommunityTextLocalization | null
}

export type CommunityPreview = ContractCommunityPreview & {
  localized_text?: CommunityTextLocalization | null
}

export type HandleUpgradeQuote = {
  desired_label: string
  tier: "standard" | "premium"
  price_usd: number
  eligible: boolean
  reason?: string | null
}

export type Env = {
  // Runtime
  ENVIRONMENT?: string
  DEV_MEMORY_STORE_ENABLED?: string
  CONTROL_PLANE_DATABASE_URL?: string

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
  PLATFORM_APPROVED_KYA_PROVIDERS?: string
  CLAWKEY_API_URL?: string
  SELF_APP_NAME?: string
  SELF_ENDPOINT?: string
  SELF_ENDPOINT_TYPE?: string
  VERY_BRIDGE_API_URL?: string

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
  HNS_CHALLENGE_TTL_HOURS?: string
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
}
